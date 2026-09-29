import { createHash } from 'node:crypto';

import type { AgentConfig } from '@job-agent/config';
import { newCorrelationId, silentLogger, type StructuredLogger } from '@job-agent/observability';
import { decodeEnvelope, encodeEnvelope, type FieldCipher } from '@job-agent/security';

import { buildEmailApplicationDraft } from './draft.js';
import { detectEmailApplicationInstruction, type VerifiedEmailInstruction } from './instruction.js';
import { buildEmailReviewManifest, chunkReview, renderEmailReview } from './manifest.js';
import type {
  EmailApplicationAuditSink,
  EmailApplicationJobSource,
  EmailApplicationJobView,
  EmailApplicationNotifier,
  EmailApplicationProfileSource,
  EmailApplicationRecord,
  EmailApplicationRepository,
} from './ports.js';
import type { EmailTransport } from './transport.js';

/**
 * Applying by email, from the advert's own instruction to a receipt.
 *
 * The shape of this service is one idea repeated: nothing is trusted twice. Every gate that decides
 * whether preparing is allowed is checked again, against freshly read data, at the moment of
 * sending — because the two moments are minutes or days apart and the person's approval was given
 * for the state of the world they were shown, not for whatever it has become since.
 *
 * What an approval is bound to: one manifest hash, one vacancy, one advert version, one CV hash,
 * one body, one provider. Anything else, and the approval does not match and nothing is sent.
 *
 * What cannot happen here: an automatic send, a retry, a second send for the same vacancy, a send
 * of a message the person has not seen, or a send whose recipient came from anywhere but the
 * advert's published instruction.
 */

export type EmailApplicationServiceOptions = {
  repository: EmailApplicationRepository;
  jobs: EmailApplicationJobSource;
  profile: EmailApplicationProfileSource;
  transport: EmailTransport;
  notifier: EmailApplicationNotifier;
  audit: EmailApplicationAuditSink;
  cipher: FieldCipher;
  config: AgentConfig;
  policyVersion: string;
  timezone?: string;
  approvalTtlSeconds?: number;
  logger?: StructuredLogger;
  now?: () => Date;
};

export type PrepareInput = {
  userId: string;
  jobId: string;
  /** Explicit, per-vacancy. It is recorded in the manifest, so approval covers the override too. */
  overrideSalaryFloor?: boolean;
  correlationId?: string;
};

export type PrepareOutcome =
  | {
      status: 'prepared';
      record: EmailApplicationRecord;
      manifestHash: string;
      reviewChunks: readonly string[];
      warnings: readonly string[];
    }
  | { status: 'refused'; reason: string; detail: string };

export type DecisionInput = {
  userId: string;
  jobId: string;
  /** At least eight characters of the manifest hash the person was shown. */
  manifestHashPrefix: string;
  /** The chat interaction that carried the decision, so a replay changes nothing. */
  requestId?: string | null;
  approverChannel?: 'discord' | 'local';
  reason?: string | null;
  correlationId?: string;
};

export type ApproveOutcome =
  | { status: 'sent'; record: EmailApplicationRecord; providerReference: string }
  | { status: 'uncertain'; record: EmailApplicationRecord; detail: string }
  | { status: 'failed'; record: EmailApplicationRecord; errorCode: string }
  | { status: 'replayed'; detail: string }
  | { status: 'refused'; reason: string; detail: string };

export type RejectOutcome =
  | { status: 'rejected'; record: EmailApplicationRecord }
  | { status: 'replayed'; detail: string }
  | { status: 'refused'; reason: string; detail: string };

export type ReconcileInput = {
  userId: string;
  jobId: string;
  outcome: 'sent' | 'not_sent';
  providerReference?: string | null;
  requestId?: string | null;
  correlationId?: string;
};

export type ReconcileOutcome =
  | { status: 'reconciled'; record: EmailApplicationRecord }
  | { status: 'refused'; reason: string; detail: string };

function localDate(now: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone }).format(now);
}

function approveCommandFor(jobId: string, manifestHash: string): string {
  return `/apply approve id:${jobId.slice(0, 8)} manifest:${manifestHash.slice(0, 12)}`;
}

function refused(
  reason: string,
  detail: string,
): { status: 'refused'; reason: string; detail: string } {
  return { status: 'refused', reason, detail };
}

/** States from which nothing may be prepared or approved again, and why. */
const terminalStateRefusals: Partial<Record<EmailApplicationRecord['state'], [string, string]>> = {
  sending: [
    'send_in_progress',
    'A send for this vacancy is already under way. Wait for its outcome rather than starting another.',
  ],
  sent: [
    'already_sent',
    'This vacancy has already been applied for by email. Nothing will be sent twice.',
  ],
  send_uncertain: [
    'awaiting_reconciliation',
    'The last send for this vacancy did not clearly succeed. Check your sent mail and record what happened before anything else is attempted.',
  ],
};

export class EmailApplicationService {
  private readonly logger: StructuredLogger;
  private readonly timezone: string;

  constructor(private readonly options: EmailApplicationServiceOptions) {
    this.logger = options.logger ?? silentLogger;
    this.timezone = options.timezone ?? options.config.project.timezone;
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  private associatedData(userId: string, jobId: string): string {
    return `email-application:${userId}:${jobId}`;
  }

  /**
   * Gates that must hold both when a review is produced and again when it is acted on.
   *
   * Returns null when everything passes. Everything it reads is passed in, so the caller decides
   * whether it is looking at the state the person saw or the state as it is now.
   */
  private vacancyGate(
    job: EmailApplicationJobView,
    salaryOverride: boolean,
    now: Date,
  ): { reason: string; detail: string } | null {
    if (job.externalSubmissionReference !== null) {
      return {
        reason: 'already_submitted',
        detail: 'This vacancy is already recorded as applied for. Nothing further will be sent.',
      };
    }
    if (['closed', 'expired', 'duplicate', 'withdrawn'].includes(job.lifecycleStatus)) {
      return { reason: 'job_closed', detail: 'This vacancy is no longer open.' };
    }
    if (job.closesAt !== null && new Date(job.closesAt).getTime() <= now.getTime()) {
      return {
        reason: 'job_closed',
        detail: `The closing date (${job.closesAt.slice(0, 10)}) has passed.`,
      };
    }
    const hardGate = job.hardRejectReasons[0];
    if (hardGate !== undefined) {
      return {
        reason: 'hard_gate_failed',
        detail:
          hardGate === 'restricted_to_internal_candidates'
            ? 'This vacancy is open only to the employer’s existing staff or a named programme.'
            : `A hard eligibility gate failed for this vacancy: ${hardGate.replace(/_/g, ' ')}.`,
      };
    }
    if (job.descriptionCompleteness === 'snippet') {
      return {
        reason: 'advert_is_excerpt_only',
        detail:
          'Only an excerpt of this advert was ever read, so its application instructions cannot be established. Add the employer’s own advert address first.',
      };
    }
    if (job.salaryGate !== 'pass' && !salaryOverride) {
      const floor = Math.round(this.options.config.matching.minimumSalary.amountMinor / 100);
      return job.salaryGate === 'reject'
        ? {
            reason: 'salary_below_minimum',
            detail: `The advertised salary is below your £${floor.toLocaleString('en-GB')} minimum. Override it explicitly if you want to apply anyway.`,
          }
        : {
            reason: 'salary_not_confirmed',
            detail: `The salary could not be confirmed against your £${floor.toLocaleString('en-GB')} minimum. Override it explicitly if you want to apply anyway.`,
          };
    }
    return null;
  }

  /**
   * Whether this vacancy could be applied for by email, and on what evidence.
   *
   * Read-only, deliberately: it writes no draft, enqueues no notification and changes no state, so
   * looking at a vacancy is never mistaken for deciding to apply to it. It runs the same gates and
   * the same instruction reading that preparing would, so a "yes" here means preparing will work.
   */
  async check(input: { userId: string; jobId: string; overrideSalaryFloor?: boolean }): Promise<
    | {
        status: 'eligible';
        recipient: string;
        recipientCorroboration: VerifiedEmailInstruction['recipientCorroboration'];
        instructionText: string;
        instructionSource: VerifiedEmailInstruction['instructionSource'];
        closesAt: string | null;
        vacancyReference: string | null;
        alreadyPrepared: boolean;
      }
    | { status: 'refused'; reason: string; detail: string }
  > {
    const now = this.now();
    if (!this.options.transport.ready) {
      return refused(
        'transport_not_configured',
        'No email provider is configured, so nothing could be sent.',
      );
    }
    const job = await this.options.jobs.load(input.userId, input.jobId);
    if (job === null) return refused('unknown_job', 'That vacancy is not on your tracker.');

    const existing = await this.options.repository.findByJob(input.userId, input.jobId);
    const blocked = existing === null ? undefined : terminalStateRefusals[existing.state];
    if (blocked !== undefined) return refused(blocked[0], blocked[1]);

    const gate = this.vacancyGate(job, input.overrideSalaryFloor === true, now);
    if (gate !== null) return refused(gate.reason, gate.detail);

    const instruction = detectEmailApplicationInstruction({
      canonicalUrl: job.canonicalUrl,
      employer: job.employer,
      description: job.description,
      personSpecificationText: job.personSpecificationText,
      closesAt: job.closesAt,
      jobVersion: job.jobVersion,
      jobContentHash: job.jobContentHash,
    });
    if (instruction.status === 'refused') {
      return refused(instruction.reason, instruction.detail);
    }
    return {
      status: 'eligible',
      recipient: instruction.recipient,
      recipientCorroboration: instruction.recipientCorroboration,
      instructionText: instruction.instructionText,
      instructionSource: instruction.instructionSource,
      closesAt: instruction.closingDate.iso,
      vacancyReference: instruction.vacancyReference?.value ?? null,
      alreadyPrepared: existing !== null,
    };
  }

  async prepare(input: PrepareInput): Promise<PrepareOutcome> {
    const now = this.now();
    const correlationId = input.correlationId ?? newCorrelationId();
    const salaryOverride = input.overrideSalaryFloor === true;

    const deny = async (reason: string, detail: string): Promise<PrepareOutcome> => {
      await this.options.audit.append({
        userId: input.userId,
        action: 'email_application.prepare_refused',
        jobId: input.jobId,
        result: 'denied',
        correlationId,
        metadata: { reason, salaryOverride },
      });
      return refused(reason, detail);
    };

    if (!this.options.transport.ready) {
      return deny(
        'transport_not_configured',
        'No email provider is configured, so nothing could be sent even if you approved it. Configure the provider first.',
      );
    }

    const job = await this.options.jobs.load(input.userId, input.jobId);
    if (job === null) return deny('unknown_job', 'That vacancy is not on your tracker.');

    const existing = await this.options.repository.findByJob(input.userId, input.jobId);
    const blocked = existing === null ? undefined : terminalStateRefusals[existing.state];
    if (blocked !== undefined) return deny(blocked[0], blocked[1]);

    const gate = this.vacancyGate(job, salaryOverride, now);
    if (gate !== null) return deny(gate.reason, gate.detail);

    const instruction = detectEmailApplicationInstruction({
      canonicalUrl: job.canonicalUrl,
      employer: job.employer,
      description: job.description,
      personSpecificationText: job.personSpecificationText,
      closesAt: job.closesAt,
      jobVersion: job.jobVersion,
      jobContentHash: job.jobContentHash,
    });
    if (instruction.status === 'refused') return deny(instruction.reason, instruction.detail);

    const facts = await this.options.profile.facts(input.userId);
    const approvedDocument = await this.options.profile.approvedDocumentReference(input.userId);
    const drafted = buildEmailApplicationDraft({
      instruction,
      title: job.title,
      employer: job.employer,
      facts,
      approvedDocument,
      now,
    });
    if (drafted.status === 'refused') return deny(drafted.reason, drafted.detail);
    const { draft } = drafted;

    const { manifest, manifestHash } = buildEmailReviewManifest({
      userId: input.userId,
      jobId: input.jobId,
      title: job.title,
      employer: job.employer,
      instruction,
      draft,
      salaryGate: job.salaryGate,
      salaryFloorMinor: this.options.config.matching.minimumSalary.amountMinor,
      salaryOverride,
      transportProvider: this.options.transport.provider,
      policyVersion: this.options.policyVersion,
    });

    const record = await this.options.repository.saveDraft({
      userId: input.userId,
      jobId: input.jobId,
      recipient: draft.recipient,
      recipientDomain: instruction.recipientDomain,
      subject: draft.subject,
      bodyCiphertext: encodeEnvelope(
        this.options.cipher.encryptJson(draft.body, this.associatedData(input.userId, input.jobId)),
      ),
      bodySha256: draft.bodySha256,
      bodyCharacters: draft.bodyCharacters,
      attachment: {
        documentId: draft.attachment.documentId,
        filename: draft.attachment.filename,
        sha256: draft.attachment.sha256,
      },
      manifestHash,
      manifest,
      instruction,
      jobVersion: job.jobVersion,
      jobContentHash: job.jobContentHash,
      closesAt: job.closesAt,
      salaryGate: job.salaryGate,
      salaryOverride,
      now,
    });

    const reviewChunks = chunkReview(
      renderEmailReview({
        manifest,
        body: draft.body,
        approveCommand: approveCommandFor(input.jobId, manifestHash),
      }),
    );
    await this.options.notifier.reviewReady({
      emailApplicationId: record.id,
      manifestHash,
      chunks: reviewChunks,
    });
    await this.options.audit.append({
      userId: input.userId,
      action: 'email_application.prepared',
      jobId: input.jobId,
      result: 'succeeded',
      correlationId,
      metadata: {
        manifestHash,
        recipientDomain: instruction.recipientDomain,
        recipientCorroboration: instruction.recipientCorroboration,
        bodyCharacters: draft.bodyCharacters,
        supportingStatement: draft.includedSupportingStatement,
        salaryGate: job.salaryGate,
        salaryOverride,
        provider: this.options.transport.provider,
      },
    });

    return {
      status: 'prepared',
      record,
      manifestHash,
      reviewChunks,
      warnings: draft.warnings,
    };
  }

  /**
   * Approves and sends, in that order and only once.
   *
   * Everything before the send is a re-check. Everything after it is bookkeeping that never guesses:
   * a clear success becomes a receipt, an unclear one becomes a question for the person, and a
   * refusal releases the reservation so the vacancy is not left looking applied for.
   */
  async approve(input: DecisionInput): Promise<ApproveOutcome> {
    const now = this.now();
    const correlationId = input.correlationId ?? newCorrelationId();
    const requestId = input.requestId ?? null;

    const deny = async (reason: string, detail: string): Promise<ApproveOutcome> => {
      await this.options.audit.append({
        userId: input.userId,
        action: 'email_application.approval_refused',
        jobId: input.jobId,
        result: 'denied',
        correlationId,
        metadata: { reason },
      });
      return refused(reason, detail);
    };

    if (!this.options.transport.ready) {
      return deny(
        'transport_not_configured',
        'No email provider is configured, so nothing can be sent.',
      );
    }
    // Checked first, and before any state gate. A command that arrives twice is the same command,
    // whatever the application has since become; answering the second one as a fresh late arrival
    // would report a refusal for a decision that in fact succeeded.
    const replayed = requestId === null ? null : await this.replayOf(requestId);
    if (replayed !== null) return replayed;

    if (input.manifestHashPrefix.length < 8) {
      return deny(
        'manifest_reference_too_short',
        'Include at least eight characters of the review reference shown with the message.',
      );
    }

    const record = await this.options.repository.findByJob(input.userId, input.jobId);
    if (record === null) {
      return deny('no_review', 'There is no prepared email application for that vacancy.');
    }
    const blocked = terminalStateRefusals[record.state];
    if (blocked !== undefined) return deny(blocked[0], blocked[1]);
    if (record.state === 'rejected' || record.state === 'failed') {
      return deny(
        'review_not_live',
        'That review is no longer live. Prepare the application again to get a fresh one.',
      );
    }
    if (!record.manifestHash.startsWith(input.manifestHashPrefix.toLowerCase())) {
      return deny(
        'stale_review',
        'That reference does not match the message now prepared for this vacancy. Read the current one and approve that.',
      );
    }

    // Re-read the vacancy. The person approved the state of the world they were shown.
    const job = await this.options.jobs.load(input.userId, input.jobId);
    if (job === null) return deny('unknown_job', 'That vacancy is no longer on your tracker.');
    const gate = this.vacancyGate(job, record.salaryOverride, now);
    if (gate !== null) return deny(gate.reason, gate.detail);
    if (job.jobVersion !== record.jobVersion || job.jobContentHash !== record.jobContentHash) {
      return deny(
        'advert_changed',
        'The advert has changed since this message was reviewed. Prepare it again and read the new version.',
      );
    }

    const instruction = detectEmailApplicationInstruction({
      canonicalUrl: job.canonicalUrl,
      employer: job.employer,
      description: job.description,
      personSpecificationText: job.personSpecificationText,
      closesAt: job.closesAt,
      jobVersion: job.jobVersion,
      jobContentHash: job.jobContentHash,
    });
    if (instruction.status === 'refused') {
      return deny(
        'instruction_changed',
        `The advert no longer gives a usable email-application instruction (${instruction.reason.replace(/_/g, ' ')}), so nothing will be sent.`,
      );
    }
    if (
      instruction.recipient !== record.recipient ||
      instruction.instructionText !== record.instruction.instructionText
    ) {
      return deny(
        'instruction_changed',
        'The advert’s application instruction is not the one this message was reviewed against.',
      );
    }

    const attachment = record.attachment;
    if (attachment === null) {
      return deny('no_approved_cv', 'This review has no attached CV recorded.');
    }
    const upload = await this.options.profile.approvedUpload(input.userId);
    if (upload === null) {
      return deny('no_approved_cv', 'There is no approved CV to attach any more.');
    }
    if (upload.sha256 !== attachment.sha256 || upload.documentId !== attachment.documentId) {
      return deny(
        'cv_changed',
        'The approved CV is not the one this message was reviewed with. Prepare the application again.',
      );
    }

    const ciphertext = await this.options.repository.readBodyCiphertext(record.id);
    if (ciphertext === null) return deny('body_missing', 'The reviewed message could not be read.');
    const body = this.options.cipher.decryptJson(
      decodeEnvelope(ciphertext),
      this.associatedData(input.userId, input.jobId),
    );
    if (typeof body !== 'string') {
      return deny('body_missing', 'The reviewed message could not be read.');
    }
    if (createHash('sha256').update(body, 'utf8').digest('hex') !== record.bodySha256) {
      return deny(
        'body_changed',
        'The stored message does not match what was reviewed, so it will not be sent.',
      );
    }

    // Recorded here rather than earlier, so a re-check that refuses leaves nothing behind. A
    // decision that already exists for this exact manifest is not a replay — a true replay was
    // caught by its request id above — so it is reused rather than refused. That matters: a first
    // approval that hit the day's cap must not make the review permanently unapprovable.
    const approval = await this.options.repository.recordDecision({
      emailApplicationId: record.id,
      manifestHash: record.manifestHash,
      decision: 'approved',
      approverChannel: input.approverChannel ?? 'discord',
      reason: input.reason ?? null,
      requestId,
      correlationId,
      ttlSeconds: this.options.approvalTtlSeconds ?? 86_400,
      now,
    });
    if (approval.approval.consumedAt !== null) {
      return deny(
        'approval_already_used',
        'That approval has already been used. Prepare the application again to approve a fresh one.',
      );
    }

    const reservation = await this.options.repository.reserveSend({
      userId: input.userId,
      emailApplicationId: record.id,
      approvalId: approval.approval.id,
      localDate: localDate(now, this.timezone),
      dailyCap: this.options.config.submission.maxAutoPerLocalDay,
      now,
    });
    if (!reservation.reserved) {
      return deny(
        reservation.capReached ? 'daily_cap_reached' : 'send_already_reserved',
        reservation.capReached
          ? `The daily limit of ${String(this.options.config.submission.maxAutoPerLocalDay)} applications has been reached (${String(reservation.usedToday)} used today).`
          : 'A send for this vacancy was already reserved. Nothing will be sent twice.',
      );
    }

    // Consumed before the send, so a crash mid-send can never make this approval usable again.
    if (!(await this.options.repository.consumeApproval(approval.approval.id, now))) {
      await this.options.repository.resolveSend({
        emailApplicationId: record.id,
        status: 'released',
        now,
      });
      return deny('approval_already_used', 'That approval had already been used.');
    }
    await this.options.repository.setState({ id: record.id, state: 'sending', now });

    const result = await this.options.transport.send({
      to: record.recipient,
      replyTo: record.manifest.replyTo,
      subject: record.subject,
      body,
      attachment: {
        filename: upload.filename,
        contentType: upload.filename.endsWith('.pdf')
          ? 'application/pdf'
          : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        contentBase64: upload.contentBase64,
        sha256: upload.sha256,
      },
      idempotencyKey: `${record.id}:${record.manifestHash}`,
    });

    const outcomeNotification = {
      emailApplicationId: record.id,
      jobId: input.jobId,
      title: job.title,
      employer: job.employer,
      recipientDomain: record.recipientDomain,
    };

    if (result.status === 'sent') {
      await this.options.repository.recordReceipt({
        emailApplicationId: record.id,
        provider: this.options.transport.provider,
        providerMessageId: result.providerMessageId,
        providerThreadId: result.providerThreadId,
        evidenceSource: 'provider_receipt',
        acceptedAt: new Date(result.acceptedAt),
        now,
      });
      await this.options.repository.resolveSend({
        emailApplicationId: record.id,
        status: 'sent',
        now,
      });
      const updated = await this.options.repository.setState({
        id: record.id,
        state: 'sent',
        failureCode: null,
        now,
      });
      await this.options.jobs.markApplied({
        userId: input.userId,
        jobId: input.jobId,
        providerReference: result.providerMessageId,
        submittedAt: new Date(result.acceptedAt),
        correlationId,
      });
      await this.options.notifier.sent({
        ...outcomeNotification,
        providerReference: result.providerMessageId,
        detail: 'The employer has been emailed and the provider acknowledged it.',
      });
      await this.options.audit.append({
        userId: input.userId,
        action: 'email_application.sent',
        jobId: input.jobId,
        result: 'succeeded',
        correlationId,
        metadata: {
          manifestHash: record.manifestHash,
          provider: this.options.transport.provider,
          providerReference: result.providerMessageId,
          recipientDomain: record.recipientDomain,
          usedToday: reservation.usedToday + 1,
        },
      });
      return { status: 'sent', record: updated, providerReference: result.providerMessageId };
    }

    if (result.status === 'uncertain') {
      // Deliberately not retried. The ledger keeps the reservation, so nothing else can send.
      await this.options.repository.resolveSend({
        emailApplicationId: record.id,
        status: 'uncertain',
        now,
      });
      const updated = await this.options.repository.setState({
        id: record.id,
        state: 'send_uncertain',
        failureCode: result.reason,
        now,
      });
      await this.options.notifier.uncertain({
        ...outcomeNotification,
        detail:
          'The provider did not confirm this message. Check your sent mail, then tell the agent what you found. It will not try again by itself.',
      });
      await this.options.audit.append({
        userId: input.userId,
        action: 'email_application.send_uncertain',
        jobId: input.jobId,
        result: 'failed',
        correlationId,
        metadata: { manifestHash: record.manifestHash, reason: result.reason },
      });
      this.logger.log('warn', 'Email application outcome is uncertain', {
        jobId: input.jobId,
        reason: result.reason,
      });
      return {
        status: 'uncertain',
        record: updated,
        detail:
          'The provider did not confirm the send. Check your sent mail and record the outcome; nothing will be retried automatically.',
      };
    }

    await this.options.repository.resolveSend({
      emailApplicationId: record.id,
      status: 'released',
      now,
    });
    const updated = await this.options.repository.setState({
      id: record.id,
      state: 'failed',
      failureCode: result.errorCode,
      now,
    });
    await this.options.notifier.failed({
      ...outcomeNotification,
      errorCode: result.errorCode,
      detail: 'Nothing was sent. The provider refused the message.',
    });
    await this.options.audit.append({
      userId: input.userId,
      action: 'email_application.send_failed',
      jobId: input.jobId,
      result: 'failed',
      correlationId,
      metadata: { manifestHash: record.manifestHash, errorCode: result.errorCode },
    });
    return { status: 'failed', record: updated, errorCode: result.errorCode };
  }

  /**
   * Whether this chat interaction has already been decided. Returned as a replay rather than as a
   * refusal, because nothing about the second copy of a command is a new request.
   */
  private async replayOf(
    requestId: string,
  ): Promise<{ status: 'replayed'; detail: string } | null> {
    const existing = await this.options.repository.decisionByRequestId(requestId);
    if (existing === null) return null;
    return {
      status: 'replayed',
      detail:
        existing.decision === 'approved'
          ? 'That approval was already handled. Nothing was repeated and nothing was sent twice.'
          : 'That rejection was already recorded. Nothing was sent.',
    };
  }

  /** Records a rejection. There is no path from here to a send. */
  async reject(input: DecisionInput): Promise<RejectOutcome> {
    const now = this.now();
    const correlationId = input.correlationId ?? newCorrelationId();
    const requestId = input.requestId ?? null;
    const replayed = requestId === null ? null : await this.replayOf(requestId);
    if (replayed !== null) return replayed;
    const record = await this.options.repository.findByJob(input.userId, input.jobId);
    if (record === null) {
      return refused('no_review', 'There is no prepared email application for that vacancy.');
    }
    const blocked = terminalStateRefusals[record.state];
    if (blocked !== undefined) return refused(blocked[0], blocked[1]);

    const decision = await this.options.repository.recordDecision({
      emailApplicationId: record.id,
      manifestHash: record.manifestHash,
      decision: 'rejected',
      approverChannel: input.approverChannel ?? 'discord',
      reason: input.reason ?? null,
      requestId,
      correlationId,
      ttlSeconds: this.options.approvalTtlSeconds ?? 86_400,
      now,
    });
    if (!decision.created) {
      return { status: 'replayed', detail: 'That rejection was already recorded.' };
    }
    const updated = await this.options.repository.setState({
      id: record.id,
      state: 'rejected',
      failureCode: null,
      now,
    });
    await this.options.audit.append({
      userId: input.userId,
      action: 'email_application.rejected',
      jobId: input.jobId,
      result: 'succeeded',
      correlationId,
      metadata: { manifestHash: record.manifestHash },
    });
    return { status: 'rejected', record: updated };
  }

  /**
   * Closes out a send whose outcome the provider never confirmed, using what the person found in
   * their own sent mail. This is the only way out of `send_uncertain`, and it is a human statement
   * of fact rather than a guess by the agent.
   */
  async reconcile(input: ReconcileInput): Promise<ReconcileOutcome> {
    const now = this.now();
    const correlationId = input.correlationId ?? newCorrelationId();
    const record = await this.options.repository.findByJob(input.userId, input.jobId);
    if (record === null) {
      return refused('no_review', 'There is no email application for that vacancy.');
    }
    if (record.state !== 'send_uncertain') {
      return refused(
        'nothing_to_reconcile',
        'That application is not waiting on an unconfirmed send.',
      );
    }

    if (input.outcome === 'sent') {
      const reference = (input.providerReference ?? '').trim();
      if (reference === '') {
        return refused(
          'reference_required',
          'Give the message reference from your sent mail, so the record says where the evidence came from.',
        );
      }
      await this.options.repository.recordReceipt({
        emailApplicationId: record.id,
        provider: this.options.transport.provider,
        providerMessageId: reference,
        providerThreadId: null,
        evidenceSource: 'user_report',
        acceptedAt: now,
        now,
      });
      await this.options.repository.resolveSend({
        emailApplicationId: record.id,
        status: 'sent',
        now,
      });
      const updated = await this.options.repository.setState({
        id: record.id,
        state: 'sent',
        failureCode: null,
        now,
      });
      await this.options.jobs.markApplied({
        userId: input.userId,
        jobId: input.jobId,
        providerReference: reference,
        submittedAt: now,
        correlationId,
      });
      await this.options.audit.append({
        userId: input.userId,
        action: 'email_application.reconciled_sent',
        jobId: input.jobId,
        result: 'succeeded',
        correlationId,
        metadata: { manifestHash: record.manifestHash, evidenceSource: 'user_report' },
      });
      return { status: 'reconciled', record: updated };
    }

    await this.options.repository.resolveSend({
      emailApplicationId: record.id,
      status: 'released',
      now,
    });
    const updated = await this.options.repository.setState({
      id: record.id,
      state: 'failed',
      failureCode: 'user_reported_not_sent',
      now,
    });
    await this.options.audit.append({
      userId: input.userId,
      action: 'email_application.reconciled_not_sent',
      jobId: input.jobId,
      result: 'succeeded',
      correlationId,
      metadata: { manifestHash: record.manifestHash },
    });
    return { status: 'reconciled', record: updated };
  }

  /**
   * Rebuilds a review's chunks for delivery.
   *
   * Nothing about the review is stored twice: it is derived again from the manifest and the
   * encrypted body, which is also why a superseded review cannot be delivered. A manifest hash that
   * no longer matches the record, or a body that no longer hashes to what was reviewed, yields
   * null and the person is told the review is not current instead of being shown stale wording.
   */
  async reviewChunks(
    emailApplicationId: string,
    manifestHash: string,
  ): Promise<readonly string[] | null> {
    const record = await this.options.repository.get(emailApplicationId);
    if (record?.manifestHash !== manifestHash) return null;
    const ciphertext = await this.options.repository.readBodyCiphertext(record.id);
    if (ciphertext === null) return null;
    let body: unknown;
    try {
      body = this.options.cipher.decryptJson(
        decodeEnvelope(ciphertext),
        this.associatedData(record.userId, record.jobId),
      );
    } catch {
      return null;
    }
    if (typeof body !== 'string') return null;
    if (createHash('sha256').update(body, 'utf8').digest('hex') !== record.bodySha256) return null;
    return chunkReview(
      renderEmailReview({
        manifest: record.manifest,
        body,
        approveCommand: approveCommandFor(record.jobId, record.manifestHash),
      }),
    );
  }

  async status(
    userId: string,
    jobId: string,
  ): Promise<{
    record: EmailApplicationRecord;
    ledger: string;
    receipt: Awaited<ReturnType<EmailApplicationRepository['receipt']>>;
  } | null> {
    const record = await this.options.repository.findByJob(userId, jobId);
    if (record === null) return null;
    return {
      record,
      ledger: await this.options.repository.ledgerStatus(record.id),
      receipt: await this.options.repository.receipt(record.id),
    };
  }

  list(userId: string, limit = 20): Promise<EmailApplicationRecord[]> {
    return this.options.repository.list(userId, limit);
  }
}
