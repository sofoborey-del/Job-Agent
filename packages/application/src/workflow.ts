import {
  advanceCheckpoint,
  checkSubmitEligibility,
  hashAnswerValue,
  issueSubmitIntent,
  manifestHash as computeManifestHash,
  mapInventory,
  previewFor,
  resolveAnswer,
  stepById,
  submissionIdempotencyKey,
  type AdapterContract,
  type BrowserAction,
  type Checkpoint,
  type FieldInventory,
  type MappedField,
  type ReviewManifest,
} from '@job-agent/browser-core';
import type { KnowledgeFact } from '@job-agent/domain';
import { newCorrelationId, silentLogger, type StructuredLogger } from '@job-agent/observability';
import type { FieldCipher } from '@job-agent/security';

import type { ApplicationStores } from './ports.js';
import type {
  ApplicationFieldRecord,
  ApplicationOverview,
  ApplicationRecord,
  AttemptRecord,
  AttemptStatus,
  QuestionRecord,
} from './types.js';

const QUESTION_TTL_HOURS = 72;
const APPROVAL_TTL_MINUTES = 30;
const MAX_VALIDATION_ROUNDS = 3;

/** Attempt states in which a repeated start is a duplicate, not a retry. */
const liveAttemptStatuses = new Set<AttemptStatus>([
  'running',
  'paused',
  'awaiting_approval',
  'submitting',
  'submitted',
  'submission_unknown',
]);

export type WorkflowOptions = {
  stores: ApplicationStores;
  cipher: FieldCipher;
  adapter: AdapterContract;
  logger?: StructuredLogger;
  timezone?: string;
};

export type StepPlan = {
  actions: BrowserAction[];
  questionsOpened: QuestionRecord[];
  pauseReason: string | null;
  /** Applicant values for this step, so the caller can hand them to the worker and redact logs. */
  secrets: string[];
};

export type SubmitPreparation =
  | {
      allowed: true;
      intentToken: string;
      snapshotHash: string;
      idempotencyKey: string;
      intentId: string;
    }
  | { allowed: false; reason: string; message: string };

function associatedData(attemptId: string, fieldKey: string): string {
  return `application-field:${attemptId}:${fieldKey}`;
}

function localDate(now: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone }).format(now);
}

/**
 * The durable workflow behind a fake-ATS application: plan a step from verified facts only, pause
 * whenever the agent may not answer, build a review manifest, bind approval to it, and permit at
 * most one final action.
 */
export class ApplicationWorkflowService {
  private readonly logger: StructuredLogger;
  private readonly timezone: string;

  constructor(private readonly options: WorkflowOptions) {
    this.logger = options.logger ?? silentLogger;
    this.timezone = options.timezone ?? 'Europe/London';
  }

  async startAttempt(input: {
    userId: string;
    jobId: string;
    matchRunId: string | null;
    policyVersion: string;
    targetOrigin: string;
    correlationId?: string;
    now?: Date;
  }): Promise<{ application: ApplicationRecord; attempt: AttemptRecord }> {
    const now = input.now ?? new Date();
    const correlationId = input.correlationId ?? newCorrelationId();
    const { stores, adapter } = this.options;
    const existing = await stores.applications.findByJob(input.userId, input.jobId);
    const application =
      existing ??
      (await stores.applications.create({
        userId: input.userId,
        jobId: input.jobId,
        matchRunId: input.matchRunId,
        policyVersion: input.policyVersion,
        adapterId: adapter.id,
        adapterVersion: adapter.version,
        correlationId,
        now,
      }));

    // Duplicate delivery of the same job must not disturb an application that is already running,
    // paused on a question, waiting for approval or finished. In those states the existing attempt
    // is handed back unchanged: no second attempt, no state change, nothing repeated.
    const live = await stores.attempts.current(application.id);
    if (live !== null && liveAttemptStatuses.has(live.status)) {
      return { application, attempt: live };
    }

    const attempt = await stores.attempts.create({
      applicationId: application.id,
      adapterId: adapter.id,
      adapterVersion: adapter.version,
      targetOrigin: input.targetOrigin,
      now,
    });
    const started = await stores.applications.transition({
      applicationId: application.id,
      to: 'STARTING',
      actor: 'system',
      reason: 'attempt_started',
      correlationId,
      now,
    });
    return { application: started, attempt };
  }

  /**
   * Turns an observed page into a plan. Every answer comes from a verified fact or an answer the
   * user gave for this application; anything else opens a question and pauses the step.
   */
  async planStep(input: {
    attemptId: string;
    inventory: FieldInventory;
    facts: readonly KnowledgeFact<unknown>[];
    approvedDocument: { documentId: string; sha256: string } | null;
    correlationId?: string;
    now?: Date;
  }): Promise<StepPlan> {
    const now = input.now ?? new Date();
    const correlationId = input.correlationId ?? newCorrelationId();
    const { stores, adapter, cipher } = this.options;
    const attempt = await stores.attempts.get(input.attemptId);
    if (attempt === null) throw new Error('unknown attempt');
    const step = stepById(adapter, input.inventory.stepId);
    if (step === null) throw new Error('unknown step');

    const applicationAnswers = (await stores.questions.readAnswers(input.attemptId)).map(
      (answer) => ({
        fieldKey: answer.fieldKey,
        value: String(
          cipher.decryptJson(
            JSON.parse(answer.ciphertext.toString('utf8')) as never,
            associatedData(input.attemptId, answer.fieldKey),
          ),
        ),
        answeredAt: now.toISOString(),
      }),
    );

    const mapped: MappedField[] = mapInventory(input.inventory);
    const actions: BrowserAction[] = [];
    const questionsOpened: QuestionRecord[] = [];
    const secrets: string[] = [];
    const fieldRows: Array<
      Omit<ApplicationFieldRecord, 'id' | 'attemptId'> & { answerCiphertext: Buffer | null }
    > = [];

    for (const field of mapped) {
      if (field.controlType === 'file') {
        if (input.approvedDocument === null) {
          const question = await this.openQuestion({
            attempt,
            stepId: input.inventory.stepId,
            field,
            reason: 'missing_evidence',
            prompt: `"${field.label}" needs an approved CV, and none is available.`,
            responseKind: 'human_action',
            correlationId,
            now,
          });
          questionsOpened.push(question);
          fieldRows.push(this.unresolvedRow(field, input.inventory.stepId, 'unresolved'));
          continue;
        }
        actions.push({
          kind: 'upload',
          stepId: input.inventory.stepId,
          fieldKey: field.fieldKey,
          selector: field.selector,
          documentId: input.approvedDocument.documentId,
          sha256: input.approvedDocument.sha256,
        });
        fieldRows.push({
          stepId: input.inventory.stepId,
          fieldKey: field.fieldKey,
          label: field.label,
          controlType: field.controlType,
          required: field.required,
          sensitive: false,
          mappedIntent: field.intent,
          mappingConfidence: field.confidence,
          answerSource: 'approved_document',
          answerHash: input.approvedDocument.sha256,
          answerPreview: 'Approved CV',
          evidenceFactIds: [],
          validationStatus: 'pending',
          validationMessage: null,
          answerCiphertext: null,
        });
        continue;
      }

      const resolution = resolveAnswer({
        field,
        facts: input.facts,
        applicationAnswers,
        now,
      });

      if (resolution.status === 'requires_user') {
        const question = await this.openQuestion({
          attempt,
          stepId: input.inventory.stepId,
          field,
          reason: resolution.reason,
          prompt: resolution.prompt,
          responseKind:
            field.humanOnly || field.sensitive
              ? 'human_action'
              : field.controlType === 'select' || field.controlType === 'radio'
                ? 'choice'
                : field.controlType === 'checkbox'
                  ? 'boolean'
                  : field.controlType === 'number'
                    ? 'number'
                    : 'text',
          allowedValues: field.options,
          correlationId,
          now,
        });
        questionsOpened.push(question);
        fieldRows.push(
          this.unresolvedRow(
            field,
            input.inventory.stepId,
            field.humanOnly || field.sensitive ? 'human_only' : 'unresolved',
          ),
        );
        continue;
      }

      secrets.push(resolution.value);
      const ciphertext = Buffer.from(
        JSON.stringify(
          cipher.encryptJson(resolution.value, associatedData(input.attemptId, field.fieldKey)),
        ),
        'utf8',
      );
      fieldRows.push({
        stepId: input.inventory.stepId,
        fieldKey: field.fieldKey,
        label: field.label,
        controlType: field.controlType,
        required: field.required,
        sensitive: field.sensitive,
        mappedIntent: field.intent,
        mappingConfidence: field.confidence,
        answerSource: resolution.source,
        answerHash: hashAnswerValue(resolution.value),
        answerPreview: previewFor(resolution.value, field.sensitive),
        evidenceFactIds: resolution.evidenceFactIds,
        validationStatus: 'pending',
        validationMessage: null,
        answerCiphertext: ciphertext,
      });

      if (field.controlType === 'select') {
        actions.push({
          kind: 'select',
          stepId: input.inventory.stepId,
          fieldKey: field.fieldKey,
          selector: field.selector,
          value: resolution.value,
          source: resolution.source === 'approved_document' ? 'verified_fact' : resolution.source,
          evidenceFactIds: resolution.evidenceFactIds,
        });
      } else if (field.controlType === 'radio' || field.controlType === 'checkbox') {
        actions.push({
          kind: 'check',
          stepId: input.inventory.stepId,
          fieldKey: field.fieldKey,
          selector: field.selector,
          checked:
            field.controlType === 'checkbox' ? resolution.value.toLowerCase() === 'yes' : true,
          ...(field.controlType === 'radio' ? { value: resolution.value } : {}),
          source: resolution.source === 'approved_document' ? 'verified_fact' : resolution.source,
          evidenceFactIds: resolution.evidenceFactIds,
        });
      } else {
        actions.push({
          kind: 'fill',
          stepId: input.inventory.stepId,
          fieldKey: field.fieldKey,
          selector: field.selector,
          value: resolution.value,
          source: resolution.source === 'approved_document' ? 'verified_fact' : resolution.source,
          evidenceFactIds: resolution.evidenceFactIds,
        });
      }
    }

    await stores.fields.replaceStep({
      attemptId: input.attemptId,
      stepId: input.inventory.stepId,
      fields: fieldRows,
      now,
    });

    const pauseReason =
      questionsOpened.length > 0 ? (step.humanOnly ? 'human_only_step' : 'questions_open') : null;

    if (pauseReason === null && step.nextSelector !== undefined) {
      actions.push({
        kind: 'click_next',
        stepId: input.inventory.stepId,
        selector: step.nextSelector,
      });
    }

    await this.saveCheckpoint({
      attempt,
      inventory: input.inventory,
      status: pauseReason === null ? 'running' : 'paused',
      pauseReason,
      now,
    });

    if (pauseReason !== null) {
      await stores.applications.transition({
        applicationId: attempt.applicationId,
        to: step.humanOnly ? 'WAITING_TAKEOVER' : 'WAITING_USER',
        actor: 'system',
        reason: pauseReason,
        correlationId,
        pauseReason,
        now,
      });
    }

    return { actions, questionsOpened, pauseReason, secrets };
  }

  private unresolvedRow(
    field: MappedField,
    stepId: string,
    source: ApplicationFieldRecord['answerSource'],
  ): Omit<ApplicationFieldRecord, 'id' | 'attemptId'> & { answerCiphertext: Buffer | null } {
    return {
      stepId,
      fieldKey: field.fieldKey,
      label: field.label,
      controlType: field.controlType,
      required: field.required,
      sensitive: field.sensitive,
      mappedIntent: field.intent,
      mappingConfidence: field.confidence,
      answerSource: source,
      answerHash: null,
      answerPreview: null,
      evidenceFactIds: [],
      validationStatus: 'pending',
      validationMessage: null,
      answerCiphertext: null,
    };
  }

  private async openQuestion(input: {
    attempt: AttemptRecord;
    stepId: string;
    field: MappedField;
    reason: string;
    prompt: string;
    responseKind: QuestionRecord['responseKind'];
    allowedValues?: string[];
    correlationId: string;
    now: Date;
  }): Promise<QuestionRecord> {
    return this.options.stores.questions.open({
      applicationId: input.attempt.applicationId,
      attemptId: input.attempt.id,
      stepId: input.stepId,
      fieldKey: input.field.fieldKey,
      reason: input.reason,
      prompt: input.prompt,
      responseKind: input.responseKind,
      allowedValues: input.allowedValues ?? [],
      correlationId: input.correlationId,
      expiresAt: new Date(input.now.getTime() + QUESTION_TTL_HOURS * 3_600_000),
      now: input.now,
    });
  }

  private async saveCheckpoint(input: {
    attempt: AttemptRecord;
    inventory: FieldInventory;
    status: AttemptRecord['status'];
    pauseReason: string | null;
    now: Date;
  }): Promise<Checkpoint> {
    const base: Checkpoint =
      input.attempt.checkpoint ??
      ({
        attemptId: input.attempt.id,
        adapterId: input.attempt.adapterId,
        adapterVersion: input.attempt.adapterVersion,
        currentStepId: input.inventory.stepId,
        currentUrl: input.inventory.url,
        pageFingerprint: input.inventory.pageFingerprint,
        completedStepIds: [],
        fieldHashes: {},
        validationMessages: [],
        pendingReason: null,
        lastSafeAction: null,
        artifactRefs: [],
        createdAt: input.now.toISOString(),
        expiresAt: new Date(input.now.getTime() + 24 * 3_600_000).toISOString(),
      } satisfies Checkpoint);
    const next = advanceCheckpoint(base, {
      currentStepId: input.inventory.stepId,
      currentUrl: input.inventory.url,
      pageFingerprint: input.inventory.pageFingerprint,
      validationMessages: input.inventory.validationMessages,
      pendingReason: input.pauseReason,
      completedStepIds:
        input.pauseReason === null ? [input.inventory.stepId] : base.completedStepIds,
    });
    await this.options.stores.attempts.saveCheckpoint({
      attemptId: input.attempt.id,
      checkpoint: next,
      status: input.status,
      pauseReason: input.pauseReason,
      now: input.now,
    });
    return next;
  }

  /** Records what the worker saw after a step, including validation rejections. */
  async recordStepResult(input: {
    attemptId: string;
    stepId: string;
    validationMessages: string[];
    round: number;
    correlationId?: string;
    now?: Date;
  }): Promise<{ retry: boolean; question: QuestionRecord | null }> {
    const now = input.now ?? new Date();
    const { stores } = this.options;
    await stores.fields.markValidation({
      attemptId: input.attemptId,
      stepId: input.stepId,
      messages: input.validationMessages,
      now,
    });
    if (input.validationMessages.length === 0) return { retry: false, question: null };
    if (input.round < MAX_VALIDATION_ROUNDS) return { retry: true, question: null };

    const attempt = await stores.attempts.get(input.attemptId);
    if (attempt === null) throw new Error('unknown attempt');
    const question = await stores.questions.open({
      applicationId: attempt.applicationId,
      attemptId: attempt.id,
      stepId: input.stepId,
      fieldKey: '__step__',
      reason: 'validation_rejected',
      prompt: `The form kept rejecting this step: ${input.validationMessages.join(' ')}`,
      responseKind: 'human_action',
      allowedValues: [],
      correlationId: input.correlationId ?? newCorrelationId(),
      expiresAt: new Date(now.getTime() + QUESTION_TTL_HOURS * 3_600_000),
      now,
    });
    await stores.attempts.setStatus({
      attemptId: attempt.id,
      status: 'paused',
      pauseReason: 'validation_rejected',
      now,
    });
    return { retry: false, question };
  }

  async buildManifest(input: {
    applicationId: string;
    attemptId: string;
    jobId: string;
    jobVersion: number;
    cvDocumentId: string | null;
    cvSha256: string | null;
    now?: Date;
  }): Promise<{ manifest: ReviewManifest; hash: string }> {
    const now = input.now ?? new Date();
    const { stores, adapter } = this.options;
    const attempt = await stores.attempts.get(input.attemptId);
    if (attempt === null) throw new Error('unknown attempt');
    const fields = await stores.fields.list(input.attemptId);
    const openQuestions = await stores.questions.listOpen(input.applicationId);
    const fingerprints =
      attempt.checkpoint === null
        ? []
        : [
            {
              stepId: attempt.checkpoint.currentStepId,
              pageFingerprint: attempt.checkpoint.pageFingerprint,
            },
          ];

    const manifest: ReviewManifest = {
      applicationId: input.applicationId,
      attemptId: input.attemptId,
      jobId: input.jobId,
      jobVersion: input.jobVersion,
      adapterId: adapter.id,
      adapterVersion: adapter.version,
      cvDocumentId: input.cvDocumentId,
      cvSha256: input.cvSha256,
      formFingerprints: fingerprints,
      answers: fields.map((field) => ({
        stepId: field.stepId,
        fieldKey: field.fieldKey,
        label: field.label,
        intent: field.mappedIntent ?? 'unknown',
        answerHash: field.answerHash,
        answerPreview: field.answerPreview,
        source: field.answerSource,
        evidenceFactIds: field.evidenceFactIds,
        sensitive: field.sensitive,
        required: field.required,
      })),
      outstandingQuestions: openQuestions.length,
      createdAt: now.toISOString(),
    };
    const hash = computeManifestHash(manifest);
    await stores.attempts.setManifestHash(input.attemptId, hash, now);
    return { manifest, hash };
  }

  async recordDecision(input: {
    applicationId: string;
    attemptId: string;
    snapshotHash: string;
    decision: 'approved' | 'rejected';
    reason: string | null;
    correlationId?: string;
    now?: Date;
  }): Promise<{ created: boolean; state: ApplicationRecord }> {
    const now = input.now ?? new Date();
    const correlationId = input.correlationId ?? newCorrelationId();
    const { stores } = this.options;
    const result = await stores.approvals.record({
      applicationId: input.applicationId,
      attemptId: input.attemptId,
      snapshotHash: input.snapshotHash,
      decision: input.decision,
      reason: input.reason,
      correlationId,
      ttlSeconds: APPROVAL_TTL_MINUTES * 60,
      now,
    });
    const state = await stores.applications.transition({
      applicationId: input.applicationId,
      to: input.decision === 'approved' ? 'READY_TO_SUBMIT' : 'CANCELLED',
      actor: 'user',
      reason: input.decision === 'approved' ? 'approved_review_manifest' : 'rejected_review',
      correlationId,
      now,
    });
    return { created: result.created, state };
  }

  /**
   * The single point where a final action becomes possible. It re-checks eligibility against the
   * live manifest, reserves the ledger row, then issues a one-use, short-lived token.
   */
  async prepareSubmit(input: {
    userId: string;
    applicationId: string;
    attemptId: string;
    currentSnapshotHash: string;
    targetOrigin: string;
    isFakeTarget: boolean;
    now?: Date;
  }): Promise<SubmitPreparation> {
    const now = input.now ?? new Date();
    const { stores } = this.options;
    const application = await stores.applications.get(input.applicationId);
    if (application === null)
      return { allowed: false, reason: 'unknown_application', message: 'No such application.' };
    const approval = await stores.approvals.latest(input.applicationId);
    const openQuestions = await stores.questions.listOpen(input.applicationId);
    const ledgerStatus = await stores.ledger.status(input.applicationId);

    const eligibility = checkSubmitEligibility({
      workflowState: application.state,
      targetOrigin: input.targetOrigin,
      isFakeTarget: input.isFakeTarget,
      approval:
        approval === null
          ? null
          : {
              snapshotHash: approval.snapshotHash,
              decision: approval.decision,
              consumedAt: approval.consumedAt,
              expiresAt: approval.expiresAt,
            },
      currentSnapshotHash: input.currentSnapshotHash,
      outstandingQuestions: openQuestions.length,
      ledgerStatus,
      now,
    });
    if (!eligibility.allowed)
      return { allowed: false, reason: eligibility.reason, message: eligibility.message };
    if (approval === null)
      return { allowed: false, reason: 'no_approval', message: 'No approval.' };

    const idempotencyKey = submissionIdempotencyKey({
      applicationId: input.applicationId,
      attemptId: input.attemptId,
      snapshotHash: input.currentSnapshotHash,
    });
    const reservation = await stores.ledger.reserve({
      userId: input.userId,
      applicationId: input.applicationId,
      attemptId: input.attemptId,
      idempotencyKey,
      localDate: localDate(now, this.timezone),
      now,
    });
    if (!reservation.reserved) {
      return {
        allowed: false,
        reason: 'already_reserved',
        message: 'A final action has already been reserved for this application.',
      };
    }

    const consumed = await stores.approvals.consume(approval.id, now);
    if (!consumed) {
      await stores.ledger.resolve({ applicationId: input.applicationId, status: 'released', now });
      return {
        allowed: false,
        reason: 'approval_already_used',
        message: 'That approval was used by another request.',
      };
    }

    const intent = issueSubmitIntent({ snapshotHash: input.currentSnapshotHash, now });
    const record = await stores.submitIntents.issue({
      applicationId: input.applicationId,
      attemptId: input.attemptId,
      approvalId: approval.id,
      tokenHash: intent.tokenHash,
      snapshotHash: intent.snapshotHash,
      targetOrigin: input.targetOrigin,
      expiresAt: new Date(intent.expiresAt),
      now,
    });
    await stores.attempts.setStatus({
      attemptId: input.attemptId,
      status: 'submitting',
      pauseReason: null,
      now,
    });
    await stores.applications.transition({
      applicationId: input.applicationId,
      to: 'SUBMITTING',
      actor: 'system',
      reason: 'submit_intent_issued',
      correlationId: newCorrelationId(),
      now,
    });
    this.logger.log('info', 'Submit intent issued for the fake ATS', {
      applicationId: input.applicationId,
      attemptId: input.attemptId,
    });
    return {
      allowed: true,
      intentToken: intent.token,
      snapshotHash: intent.snapshotHash,
      idempotencyKey,
      intentId: record.id,
    };
  }

  /** Records what the fake ATS actually did. An unclear result never retries by itself. */
  async recordSubmissionOutcome(input: {
    applicationId: string;
    attemptId: string;
    intentId: string;
    outcome: 'submitted' | 'unknown' | 'failed';
    confirmationReference: string | null;
    correlationId?: string;
    now?: Date;
  }): Promise<{ state: ApplicationRecord }> {
    const now = input.now ?? new Date();
    const correlationId = input.correlationId ?? newCorrelationId();
    const { stores } = this.options;
    await stores.submitIntents.consume({ intentId: input.intentId, result: input.outcome, now });

    if (input.outcome === 'submitted' && input.confirmationReference !== null) {
      await stores.receipts.record({
        applicationId: input.applicationId,
        attemptId: input.attemptId,
        providerReference: input.confirmationReference,
        confirmationUrlHash: null,
        now,
      });
      await stores.ledger.resolve({ applicationId: input.applicationId, status: 'confirmed', now });
      await stores.attempts.setStatus({
        attemptId: input.attemptId,
        status: 'submitted',
        pauseReason: null,
        now,
      });
      return {
        state: await stores.applications.transition({
          applicationId: input.applicationId,
          to: 'SUBMITTED',
          actor: 'worker',
          reason: 'fake_ats_confirmation_received',
          correlationId,
          now,
        }),
      };
    }

    // Ambiguous or failed: the reservation stays in place and a human resolves it.
    await stores.ledger.resolve({ applicationId: input.applicationId, status: 'unknown', now });
    await stores.attempts.setStatus({
      attemptId: input.attemptId,
      status: 'submission_unknown',
      pauseReason: 'submission_outcome_unclear',
      now,
    });
    return {
      state: await stores.applications.transition({
        applicationId: input.applicationId,
        to: 'SUBMISSION_UNKNOWN',
        actor: 'worker',
        reason: 'fake_ats_outcome_unclear',
        correlationId,
        pauseReason: 'submission_outcome_unclear',
        now,
      }),
    };
  }

  async requestTakeover(input: {
    applicationId: string;
    correlationId?: string;
    now?: Date;
  }): Promise<ApplicationRecord> {
    const now = input.now ?? new Date();
    const correlationId = input.correlationId ?? newCorrelationId();
    await this.options.stores.applications.setTakeover({
      applicationId: input.applicationId,
      requested: true,
      correlationId,
      now,
    });
    return this.options.stores.applications.transition({
      applicationId: input.applicationId,
      to: 'WAITING_TAKEOVER',
      actor: 'user',
      reason: 'manual_takeover_requested',
      correlationId,
      pauseReason: 'manual_takeover',
      now,
    });
  }

  async resume(input: {
    applicationId: string;
    correlationId?: string;
    now?: Date;
  }): Promise<{ resumed: boolean; message: string; state: ApplicationRecord }> {
    const now = input.now ?? new Date();
    const correlationId = input.correlationId ?? newCorrelationId();
    const { stores } = this.options;
    const application = await stores.applications.get(input.applicationId);
    if (application === null) throw new Error('unknown application');
    const open = await stores.questions.listOpen(input.applicationId);
    if (open.length > 0) {
      return {
        resumed: false,
        message: `${String(open.length)} question(s) are still waiting for you.`,
        state: application,
      };
    }
    await stores.applications.setTakeover({
      applicationId: input.applicationId,
      requested: false,
      correlationId,
      now,
    });
    const attempt = await stores.attempts.current(input.applicationId);
    if (attempt !== null) {
      await stores.attempts.setStatus({
        attemptId: attempt.id,
        status: 'running',
        pauseReason: null,
        now,
      });
    }
    return {
      resumed: true,
      message: 'Resumed.',
      state: await stores.applications.transition({
        applicationId: input.applicationId,
        to: 'FILLING',
        actor: 'user',
        reason: 'resumed_by_user',
        correlationId,
        pauseReason: null,
        now,
      }),
    };
  }

  async overview(applicationId: string): Promise<ApplicationOverview | null> {
    const { stores } = this.options;
    const application = await stores.applications.get(applicationId);
    if (application === null) return null;
    const attempt = await stores.attempts.current(applicationId);
    return {
      application,
      attempt,
      openQuestions: await stores.questions.listOpen(applicationId),
      fields: attempt === null ? [] : await stores.fields.list(attempt.id),
      manifest: null,
      manifestHash: attempt?.answerManifestHash ?? null,
      approval: await stores.approvals.latest(applicationId),
      ledgerStatus: await stores.ledger.status(applicationId),
      receipt: await stores.receipts.get(applicationId),
      artifacts: attempt === null ? [] : await stores.artifacts.list(attempt.id),
    };
  }
}
