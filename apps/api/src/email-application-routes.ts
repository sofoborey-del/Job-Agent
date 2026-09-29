import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import type { ApplicationRepository } from '@job-agent/application';
import type {
  EmailApplicationCommandPort,
  EmailApplicationView,
  EmailCommandResult,
} from '@job-agent/notifications';
import type {
  EmailApplicationJobSource,
  EmailApplicationJobView,
  EmailApplicationNotifier,
  EmailApplicationProfileSource,
  EmailApplicationRecord,
  EmailApplicationService,
  OutcomeNotification,
  ReviewNotification,
} from '@job-agent/email-application';
import { newCorrelationId } from '@job-agent/observability';
import type { CvProcessingService, ProfileService } from '@job-agent/profile';
import { canChangeReviewStatus, type TrackingStores } from '@job-agent/tracking';

/**
 * Wiring for applying by email: the local routes, the adapters onto the existing tracker and
 * profile, and the Discord port.
 *
 * Only the Discord port and these routes can reach the service, and only the service can reach the
 * transport. Nothing in the browser path is touched: that runs against the bundled fake ATS and
 * remains the only thing that drives a form.
 */

export type EmailApplicationRuntime = {
  service: EmailApplicationService;
  userId: string;
  providerName: string;
};

/** Reads a vacancy for the gates, from the tracker rather than from the network. */
export class TrackerJobSource implements EmailApplicationJobSource {
  constructor(
    private readonly tracking: TrackingStores,
    private readonly applications: ApplicationRepository,
  ) {}

  async load(userId: string, jobId: string): Promise<EmailApplicationJobView | null> {
    const detail = await this.tracking.tracking.detail(userId, jobId);
    if (detail === null) return null;
    // The advert text and the criteria document live on the matching view, which is also what the
    // matcher reads, so the instruction is verified against exactly the recorded advert.
    const matchable = await this.tracking.tracking.getForMatching(userId, jobId);
    const submission = await this.applications.externalSubmission(userId, jobId);
    return {
      jobId,
      title: detail.title,
      employer: detail.employer,
      canonicalUrl: detail.canonicalUrl,
      description: matchable?.job.description ?? '',
      personSpecificationText: matchable?.job.personSpecification.text ?? null,
      closesAt: detail.closesAt,
      jobVersion: detail.jobVersion,
      jobContentHash: matchable?.job.contentHash ?? '',
      lifecycleStatus: detail.lifecycleStatus,
      descriptionCompleteness: detail.descriptionCompleteness,
      salaryGate: detail.salaryGate ?? 'unknown',
      hardRejectReasons: detail.matchRun?.explanation.hardRejectReasons ?? [],
      externalSubmissionReference: submission?.providerReference ?? null,
    };
  }

  async markApplied(input: {
    userId: string;
    jobId: string;
    providerReference: string;
    submittedAt: Date;
    correlationId: string;
  }): Promise<void> {
    // The external-submission record is the authoritative "this has been applied for" marker: the
    // preparation view, the answer pack and this service all refuse a vacancy that carries one.
    await this.applications.recordExternalSubmission({
      userId: input.userId,
      jobId: input.jobId,
      providerReference: input.providerReference,
      submittedAt: input.submittedAt,
    });
    const detail = await this.tracking.tracking.detail(input.userId, input.jobId);
    if (detail === null || !canChangeReviewStatus(detail.reviewStatus, 'reviewed')) return;
    await this.tracking.tracking.changeReviewStatus({
      userId: input.userId,
      jobId: input.jobId,
      to: 'reviewed',
      actor: 'user',
      decidedBy: 'user',
      reason: 'applied for by email',
      correlationId: input.correlationId,
      now: input.submittedAt,
    });
  }
}

export class LocalProfileSource implements EmailApplicationProfileSource {
  constructor(
    private readonly profiles: ProfileService,
    private readonly documents: CvProcessingService,
  ) {}

  facts(userId: string) {
    return this.profiles.listFacts(userId);
  }

  approvedDocumentReference(userId: string) {
    return this.documents.approvedDocumentReference(userId);
  }

  /** The one call that decrypts the CV. Its bytes go to the transport and nowhere else. */
  approvedUpload(userId: string) {
    return this.documents.approvedUpload(userId);
  }
}

/**
 * Notifications through the existing outbox.
 *
 * The review is enqueued as one event per message, and each event carries a reference and a part
 * number rather than the wording. The publisher fetches the text from local encrypted storage as it
 * delivers, so the durable row — the thing that is queried, retried and logged — never holds it.
 */
export class OutboxEmailNotifier implements EmailApplicationNotifier {
  constructor(private readonly stores: TrackingStores) {}

  async reviewReady(notification: ReviewNotification): Promise<void> {
    const correlationId = newCorrelationId();
    const now = new Date();
    for (const [index] of notification.chunks.entries()) {
      await this.stores.outbox.enqueue(
        {
          eventType: 'EMAIL_APPLICATION_REVIEW',
          channel: 'discord',
          dedupeKey: `email_review:${notification.manifestHash}:${String(index)}`,
          correlationId,
          payload: {
            reviewRef: `${notification.emailApplicationId}:${notification.manifestHash}`,
            chunkIndex: index,
            chunkCount: notification.chunks.length,
            emailApplicationId: notification.emailApplicationId,
            manifestRef: notification.manifestHash.slice(0, 12),
          },
          // Staggered so the parts are claimed, and read, in order.
          availableAt: new Date(now.getTime() + index),
        },
        now,
      );
    }
  }

  sent(notification: OutcomeNotification & { providerReference: string }): Promise<void> {
    return this.enqueueOutcome('EMAIL_APPLICATION_SENT', notification, {
      providerReference: notification.providerReference,
    });
  }

  uncertain(notification: OutcomeNotification): Promise<void> {
    return this.enqueueOutcome('EMAIL_APPLICATION_UNCERTAIN', notification, {});
  }

  failed(notification: OutcomeNotification & { errorCode: string }): Promise<void> {
    return this.enqueueOutcome('EMAIL_APPLICATION_FAILED', notification, {
      errorCode: notification.errorCode,
    });
  }

  private async enqueueOutcome(
    eventType: string,
    notification: OutcomeNotification,
    extra: Record<string, unknown>,
  ): Promise<void> {
    const now = new Date();
    await this.stores.outbox.enqueue(
      {
        eventType,
        channel: 'discord',
        dedupeKey: `${eventType}:${notification.emailApplicationId}`,
        correlationId: newCorrelationId(),
        payload: {
          jobId: notification.jobId,
          title: notification.title,
          employer: notification.employer,
          recipientDomain: notification.recipientDomain,
          detail: notification.detail,
          ...extra,
        },
      },
      now,
    );
  }
}

function summarise(record: EmailApplicationRecord, providerReference: string | null) {
  return {
    jobId: record.jobId,
    state: record.state,
    recipientDomain: record.recipientDomain,
    subject: record.subject,
    manifestRef: record.manifestHash.slice(0, 12),
    attachment:
      record.attachment === null
        ? null
        : { filename: record.attachment.filename, sha256: record.attachment.sha256 },
    bodyCharacters: record.bodyCharacters,
    salaryOverride: record.salaryOverride,
    failureCode: record.failureCode,
    providerReference,
    updatedAt: record.updatedAt,
  };
}

const prepareSchema = z.object({ overrideSalaryFloor: z.boolean().default(false) });
const approveSchema = z.object({
  manifestHash: z.string().min(8).max(64),
  confirmed: z.literal(true),
});
const rejectSchema = z.object({ reason: z.string().max(400).optional() });
const reconcileSchema = z.object({
  outcome: z.enum(['sent', 'not_sent']),
  providerReference: z.string().trim().max(400).optional(),
});

/**
 * The local screens' interface to applying by email. These routes sit behind the admin token, like
 * every other local route, and behind the same service gates as the Discord commands.
 */
export function registerEmailApplicationRoutes(
  app: FastifyInstance,
  runtime: EmailApplicationRuntime,
): void {
  const ids = (params: { userId: string; jobId: string }) => {
    const userId = z.uuid().safeParse(params.userId);
    const jobId = z.uuid().safeParse(params.jobId);
    return userId.success && jobId.success ? { userId: userId.data, jobId: jobId.data } : null;
  };

  app.get<{ Params: { userId: string } }>(
    '/v1/email-applications/:userId',
    async (request, reply) => {
      const userId = z.uuid().safeParse(request.params.userId);
      if (!userId.success) return reply.code(400).send({ error: 'invalid_request' });
      const records = await runtime.service.list(userId.data, 20);
      return reply.header('cache-control', 'no-store').send({
        provider: runtime.providerName,
        applications: records.map((record) => summarise(record, null)),
      });
    },
  );

  app.get<{ Params: { userId: string; jobId: string } }>(
    '/v1/email-applications/:userId/:jobId',
    async (request, reply) => {
      const parsed = ids(request.params);
      if (parsed === null) return reply.code(400).send({ error: 'invalid_request' });
      const status = await runtime.service.status(parsed.userId, parsed.jobId);
      if (status === null) return reply.code(404).send({ error: 'no_review' });
      return reply.header('cache-control', 'no-store').send({
        provider: runtime.providerName,
        ledger: status.ledger,
        receipt: status.receipt,
        application: summarise(status.record, status.receipt?.providerMessageId ?? null),
      });
    },
  );

  /** Read-only: whether this vacancy could be applied for by email, and on what evidence. */
  app.get<{ Params: { userId: string; jobId: string } }>(
    '/v1/email-applications/:userId/:jobId/check',
    async (request, reply) => {
      const parsed = ids(request.params);
      if (parsed === null) return reply.code(400).send({ error: 'invalid_request' });
      const result = await runtime.service.check({
        userId: parsed.userId,
        jobId: parsed.jobId,
      });
      if (result.status === 'refused') {
        return reply
          .code(409)
          .header('cache-control', 'no-store')
          .send({ error: result.reason, message: result.detail, sent: false });
      }
      return reply.header('cache-control', 'no-store').send({ ...result, sent: false });
    },
  );

  app.post<{ Params: { userId: string; jobId: string } }>(
    '/v1/email-applications/:userId/:jobId/prepare',
    async (request, reply) => {
      const parsed = ids(request.params);
      const body = prepareSchema.safeParse(request.body ?? {});
      if (parsed === null || !body.success)
        return reply.code(400).send({ error: 'invalid_request' });
      const result = await runtime.service.prepare({
        userId: parsed.userId,
        jobId: parsed.jobId,
        overrideSalaryFloor: body.data.overrideSalaryFloor,
      });
      if (result.status === 'refused') {
        return reply
          .code(409)
          .header('cache-control', 'no-store')
          .send({ error: result.reason, message: result.detail, sent: false });
      }
      return reply.header('cache-control', 'no-store').send({
        manifestHash: result.manifestHash,
        application: summarise(result.record, null),
        // The full review, for a local screen. It is behind the admin token, like the CV review.
        review: result.reviewChunks,
        warnings: result.warnings,
        sent: false,
      });
    },
  );

  app.post<{ Params: { userId: string; jobId: string } }>(
    '/v1/email-applications/:userId/:jobId/approve',
    async (request, reply) => {
      const parsed = ids(request.params);
      const body = approveSchema.safeParse(request.body);
      if (parsed === null || !body.success)
        return reply.code(400).send({ error: 'invalid_request' });
      const result = await runtime.service.approve({
        userId: parsed.userId,
        jobId: parsed.jobId,
        manifestHashPrefix: body.data.manifestHash,
        approverChannel: 'local',
        requestId: null,
      });
      if (result.status === 'refused') {
        return reply
          .code(409)
          .header('cache-control', 'no-store')
          .send({ error: result.reason, message: result.detail, sent: false });
      }
      if (result.status === 'replayed') {
        return reply
          .header('cache-control', 'no-store')
          .send({ outcome: 'replayed', message: result.detail });
      }
      return reply.header('cache-control', 'no-store').send({
        outcome: result.status,
        sent: result.status === 'sent',
        ...(result.status === 'sent' ? { providerReference: result.providerReference } : {}),
        ...(result.status === 'uncertain' ? { message: result.detail } : {}),
        ...(result.status === 'failed' ? { errorCode: result.errorCode } : {}),
        application: summarise(result.record, null),
      });
    },
  );

  app.post<{ Params: { userId: string; jobId: string } }>(
    '/v1/email-applications/:userId/:jobId/reject',
    async (request, reply) => {
      const parsed = ids(request.params);
      const body = rejectSchema.safeParse(request.body ?? {});
      if (parsed === null || !body.success)
        return reply.code(400).send({ error: 'invalid_request' });
      const result = await runtime.service.reject({
        userId: parsed.userId,
        jobId: parsed.jobId,
        manifestHashPrefix: '',
        approverChannel: 'local',
        requestId: null,
        ...(body.data.reason === undefined ? {} : { reason: body.data.reason }),
      });
      if (result.status === 'refused') {
        return reply.code(409).send({ error: result.reason, message: result.detail, sent: false });
      }
      if (result.status === 'replayed') {
        return reply.send({ outcome: 'replayed', message: result.detail, sent: false });
      }
      return reply
        .header('cache-control', 'no-store')
        .send({ outcome: 'rejected', sent: false, application: summarise(result.record, null) });
    },
  );

  app.post<{ Params: { userId: string; jobId: string } }>(
    '/v1/email-applications/:userId/:jobId/reconcile',
    async (request, reply) => {
      const parsed = ids(request.params);
      const body = reconcileSchema.safeParse(request.body);
      if (parsed === null || !body.success)
        return reply.code(400).send({ error: 'invalid_request' });
      const result = await runtime.service.reconcile({
        userId: parsed.userId,
        jobId: parsed.jobId,
        outcome: body.data.outcome,
        ...(body.data.providerReference === undefined
          ? {}
          : { providerReference: body.data.providerReference }),
      });
      if (result.status === 'refused') {
        return reply.code(409).send({ error: result.reason, message: result.detail });
      }
      return reply
        .header('cache-control', 'no-store')
        .send({ outcome: 'reconciled', application: summarise(result.record, null) });
    },
  );
}

/**
 * The Discord surface's view of the service.
 *
 * Every method resolves a short job id against the person's own tracker first, so a command can
 * only ever name a vacancy they already have. The replies are written for a chat window: short,
 * plain, and never carrying the message body, which the person reads in the review itself.
 */
export function createEmailApplicationCommandPort(
  runtime: EmailApplicationRuntime,
  tracking: TrackingStores,
): EmailApplicationCommandPort {
  const userId = runtime.userId;

  const resolveJob = async (
    jobIdPrefix: string,
  ): Promise<{ jobId: string; title: string } | null> => {
    const page = await tracking.tracking.list({ userId, limit: 200 });
    const job = page.jobs.find((candidate) => candidate.jobId.startsWith(jobIdPrefix));
    return job === undefined ? null : { jobId: job.jobId, title: job.title };
  };

  const unknownJob = (): EmailCommandResult => ({
    ok: false,
    message: 'I could not find a vacancy with that id on your tracker.',
  });

  return {
    async check(jobIdPrefix) {
      const job = await resolveJob(jobIdPrefix);
      if (job === null) return unknownJob();
      // Read-only. It writes no draft and posts no review, so looking is never mistaken for
      // deciding to apply.
      const result = await runtime.service.check({ userId, jobId: job.jobId });
      if (result.status === 'refused')
        return { ok: false, message: `Not offered: ${result.detail}` };
      return {
        ok: true,
        message: [
          `"${job.title}" asks candidates to apply by email.`,
          `To: ${result.recipient}`,
          result.recipientCorroboration === 'advert_domain'
            ? 'That address is on the same domain as the advert.'
            : result.recipientCorroboration === 'employer_name'
              ? 'That address is not on the advert’s domain, but its domain matches the employer’s name.'
              : 'That address is neither on the advert’s domain nor matched to the employer’s name. Check it yourself.',
          `The advert says: ${result.instructionText}`,
          result.closesAt === null ? '' : `Closing date: ${result.closesAt.slice(0, 10)}`,
          result.vacancyReference === null ? '' : `Reference: ${result.vacancyReference}`,
          result.alreadyPrepared
            ? 'A message has already been prepared for it; /apply status shows where it stands.'
            : 'Nothing has been prepared or sent. Use /apply prepare to build the message.',
        ]
          .filter((line) => line !== '')
          .join('\n'),
      };
    },

    async prepare(input) {
      const job = await resolveJob(input.jobIdPrefix);
      if (job === null) return unknownJob();
      const result = await runtime.service.prepare({
        userId,
        jobId: job.jobId,
        overrideSalaryFloor: input.overrideSalaryFloor,
      });
      return result.status === 'refused'
        ? { ok: false, message: `Not prepared: ${result.detail}` }
        : {
            ok: true,
            message: `The message for "${job.title}" is ready and is being posted here for you to read. Nothing has been sent. Approve it with reference ${result.manifestHash.slice(0, 12)}.`,
          };
    },

    async approve(input) {
      const job = await resolveJob(input.jobIdPrefix);
      if (job === null) return unknownJob();
      const result = await runtime.service.approve({
        userId,
        jobId: job.jobId,
        manifestHashPrefix: input.manifestHashPrefix,
        requestId: input.requestId,
        approverChannel: 'discord',
      });
      if (result.status === 'refused') return { ok: false, message: `Not sent: ${result.detail}` };
      if (result.status === 'replayed') return { ok: true, message: result.detail };
      if (result.status === 'sent') {
        return {
          ok: true,
          message: `Sent. "${job.title}" has been applied for by email, reference ${result.providerReference}. Your tracker now records it as applied for.`,
        };
      }
      if (result.status === 'uncertain') return { ok: false, message: result.detail };
      return {
        ok: false,
        message: `Nothing was sent (${result.errorCode.replace(/_/g, ' ')}). The vacancy is untouched and you can prepare it again.`,
      };
    },

    async reject(input) {
      const job = await resolveJob(input.jobIdPrefix);
      if (job === null) return unknownJob();
      const result = await runtime.service.reject({
        userId,
        jobId: job.jobId,
        manifestHashPrefix: '',
        requestId: input.requestId,
        reason: input.reason,
        approverChannel: 'discord',
      });
      if (result.status === 'refused') return { ok: false, message: result.detail };
      if (result.status === 'replayed') return { ok: true, message: result.detail };
      return { ok: true, message: `Rejected. Nothing was sent for "${job.title}".` };
    },

    async reconcile(input) {
      const job = await resolveJob(input.jobIdPrefix);
      if (job === null) return unknownJob();
      const result = await runtime.service.reconcile({
        userId,
        jobId: job.jobId,
        outcome: input.outcome,
        providerReference: input.providerReference,
      });
      if (result.status === 'refused') return { ok: false, message: result.detail };
      return {
        ok: true,
        message:
          input.outcome === 'sent'
            ? `Recorded as sent on your word, with the reference you gave. "${job.title}" will not be applied for again.`
            : `Recorded as not sent. "${job.title}" is free to prepare again.`,
      };
    },

    async status(jobIdPrefix) {
      const job = await resolveJob(jobIdPrefix);
      if (job === null) return unknownJob();
      const status = await runtime.service.status(userId, job.jobId);
      if (status === null) {
        return { ok: true, message: `No email application has been prepared for "${job.title}".` };
      }
      return {
        ok: true,
        message: [
          `${job.title} — ${status.record.state.replace(/_/g, ' ')}`,
          `Recipient domain: ${status.record.recipientDomain}`,
          `Review reference: ${status.record.manifestHash.slice(0, 12)}`,
          status.receipt === null
            ? 'No provider receipt.'
            : `Receipt: ${status.receipt.providerMessageId} (${status.receipt.evidenceSource.replace(/_/g, ' ')})`,
          status.record.failureCode === null
            ? ''
            : `Last problem: ${status.record.failureCode.replace(/_/g, ' ')}`,
        ]
          .filter((line) => line !== '')
          .join('\n'),
      };
    },

    async list(limit) {
      const records = await runtime.service.list(userId, limit);
      const views: EmailApplicationView[] = [];
      for (const record of records) {
        const detail = await tracking.tracking.detail(userId, record.jobId);
        const status = await runtime.service.status(userId, record.jobId);
        views.push({
          jobId: record.jobId,
          jobTitle: detail?.title ?? 'a vacancy',
          employer: detail?.employer ?? 'an employer',
          state: record.state,
          recipientDomain: record.recipientDomain,
          manifestHashPrefix: record.manifestHash.slice(0, 12),
          providerReference: status?.receipt?.providerMessageId ?? null,
          failureCode: record.failureCode,
          updatedAt: record.updatedAt,
        });
      }
      return views;
    },
  };
}
