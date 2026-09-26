import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import type { ApplicationStores, ApplicationWorkflowService } from '@job-agent/application';
import { realSiteAdapterForUrl } from '@job-agent/adapters';
import type { AdapterContract } from '@job-agent/browser-core';
import type { KnowledgeFact } from '@job-agent/domain';
import type { ApplicationRunner, RunOutcome } from '@job-agent/orchestrator';
import type {
  ApplicationCommandPort,
  ApplicationSummaryView,
  CommandResult,
  PausedQuestionView,
} from '@job-agent/notifications';
import { newCorrelationId } from '@job-agent/observability';
import type { FieldCipher } from '@job-agent/security';
import type { TrackingStores } from '@job-agent/tracking';

import { applicationsPageHtml } from './applications-page.js';
import { preparationView } from './real-site-preparation.js';

export type ApprovedDocument = {
  documentId: string;
  sha256: string;
  filename: string;
  contentBase64: string;
};

/**
 * What a route needs in order to actually drive the browser. It is optional: without it the start
 * and advance routes refuse with `driving_unavailable` rather than half-working, which is what the
 * screens showed before this existed.
 */
export type ApplicationDrive = {
  runner: ApplicationRunner;
  loadFacts: (userId: string) => Promise<readonly KnowledgeFact<unknown>[]>;
  loadApprovedDocument: (userId: string) => Promise<ApprovedDocument | null>;
  policyVersion: string;
};

export type ApplicationRuntime = {
  stores: ApplicationStores;
  tracking: TrackingStores;
  workflow: ApplicationWorkflowService;
  adapter: AdapterContract;
  cipher: FieldCipher;
  fakeAtsOrigin: string;
  drive?: ApplicationDrive | null;
};

const answerSchema = z.object({
  value: z.string().min(1).max(20_000),
  saveToProfile: z.boolean().default(false),
  responseVersion: z.number().int().min(1).max(1_000_000).default(1),
});

const decisionSchema = z.object({
  decision: z.enum(['approved', 'rejected']),
  manifestHash: z.string().length(64),
  reason: z.string().max(400).optional(),
});

const startSchema = z.object({ jobId: z.uuid() });

const reviewSchema = z.object({
  jobId: z.uuid(),
  jobVersion: z.number().int().positive().default(1),
  cvDocumentId: z.uuid().nullable().default(null),
  cvSha256: z.string().length(64).nullable().default(null),
});

function associatedData(attemptId: string, fieldKey: string): string {
  return `application-field:${attemptId}:${fieldKey}`;
}

/**
 * The local application screens and their data. Everything here concerns the bundled fake ATS.
 * There is no route that can start, fill or submit a real employer application.
 */
export function registerApplicationRoutes(app: FastifyInstance, runtime: ApplicationRuntime): void {
  app.get<{ Params: { userId: string; jobId: string } }>(
    '/v1/applications/:userId/external-submission/:jobId',
    async (request, reply) => {
      const userId = z.uuid().safeParse(request.params.userId);
      const jobId = z.uuid().safeParse(request.params.jobId);
      if (!userId.success || !jobId.success)
        return reply.code(400).send({ error: 'invalid_request' });
      if ((await runtime.tracking.tracking.detail(userId.data, jobId.data)) === null)
        return reply.code(404).send({ error: 'unknown_job' });
      return reply.header('cache-control', 'no-store').send({
        submission: await runtime.stores.applications.externalSubmission(userId.data, jobId.data),
      });
    },
  );
  const externalSchema = z.object({
    jobId: z.uuid(),
    providerReference: z.string().trim().min(1).max(120),
    submittedAt: z.iso.datetime({ offset: true }),
    confirmed: z.literal(true),
  });
  app.post<{ Params: { userId: string } }>(
    '/v1/applications/:userId/external-submission',
    async (request, reply) => {
      const userId = z.uuid().safeParse(request.params.userId);
      const body = externalSchema.safeParse(request.body);
      if (!userId.success || !body.success)
        return reply.code(400).send({ error: 'invalid_request' });
      const job = await runtime.tracking.tracking.detail(userId.data, body.data.jobId);
      if (job === null) return reply.code(404).send({ error: 'unknown_job' });
      if (new Date(body.data.submittedAt).getTime() > Date.now())
        return reply.code(400).send({ error: 'future_submission_date' });
      await runtime.stores.applications.recordExternalSubmission({
        userId: userId.data,
        jobId: body.data.jobId,
        providerReference: body.data.providerReference,
        submittedAt: new Date(body.data.submittedAt),
      });
      await runtime.tracking.audit.append(
        {
          userId: userId.data,
          actorType: 'user',
          actorId: null,
          action: 'application.external_submission_recorded',
          resourceType: 'job',
          resourceId: body.data.jobId,
          result: 'succeeded',
          policyVersion: null,
          correlationId: newCorrelationId(),
          metadata: { evidenceSource: 'user_report' },
        },
        new Date(),
      );
      return reply.header('cache-control', 'no-store').send({
        status: 'submitted',
        submission: await runtime.stores.applications.externalSubmission(
          userId.data,
          body.data.jobId,
        ),
        duplicateApplicationBlocked: true,
      });
    },
  );
  app.get<{ Params: { userId: string; jobId: string } }>(
    '/v1/applications/:userId/preparation/:jobId',
    async (request, reply) => {
      const userId = z.uuid().safeParse(request.params.userId);
      const jobId = z.uuid().safeParse(request.params.jobId);
      if (!userId.success || !jobId.success)
        return reply.code(400).send({ error: 'invalid_request' });
      const job = await runtime.tracking.tracking.detail(userId.data, jobId.data);
      if (job === null) return reply.code(404).send({ error: 'unknown_job' });
      const submission = await runtime.stores.applications.externalSubmission(
        userId.data,
        jobId.data,
      );
      const closed =
        ['closed', 'expired', 'duplicate'].includes(job.lifecycleStatus) ||
        (job.closesAt !== null && new Date(job.closesAt).getTime() <= Date.now());
      const facts =
        submission !== null || closed ? [] : ((await runtime.drive?.loadFacts(userId.data)) ?? []);
      const safeKeys =
        /^(identity\.(first_name|last_name)|contact\.(email|phone|address)|employment\.|education\.|skills\.|certifications_licences\.)/;
      const usable = facts.filter(
        (f) =>
          safeKeys.test(f.key) &&
          f.status === 'verified' &&
          f.usePolicy === 'auto_fill' &&
          f.sensitivity !== 'high_risk' &&
          f.allowedPurposes.includes('application') &&
          (f.expiresAt === undefined || new Date(f.expiresAt).getTime() > Date.now()),
      );
      // The reviewed real-site adapter, if one covers this address. It stays at its shipped
      // execution mode, which is disabled: nothing here switches prefill on.
      const adapter = realSiteAdapterForUrl(job.canonicalUrl);
      const attempt = await runtime.stores.applications.findByJob(userId.data, jobId.data);
      const preparation = preparationView({
        applyUrl: job.canonicalUrl,
        lifecycleStatus: job.lifecycleStatus,
        closesAt: job.closesAt,
        hardRejectReasons: job.matchRun?.explanation.hardRejectReasons ?? [],
        externalSubmission: submission,
        adapter,
        // No reviewed policy grants prefill on this domain yet; see docs/real-application-pilot.md.
        sitePolicyPermitsPrefill: false,
        userAuthenticated: false,
        attempt:
          attempt === null
            ? null
            : {
                openQuestions: (await runtime.stores.questions.listOpen(attempt.id)).length,
                reachedReview:
                  attempt.state === 'READY_FOR_REVIEW' || attempt.state === 'WAITING_APPROVAL',
              },
      });

      return reply.header('cache-control', 'no-store').send({
        jobId: jobId.data,
        status:
          submission !== null ? 'submitted' : closed ? 'blocked_closed' : 'manual_preparation',
        preparation,
        submission,
        browserPrefillEnabled: preparation.prefillPermitted,
        autoSubmitEnabled: false,
        facts: usable.map((f) => ({
          key: f.key,
          value: f.value,
          sourceFactId: f.id,
          version: f.version,
        })),
        requirements: job.matchRun?.explanation.requirements ?? [],
        message:
          submission !== null
            ? 'Already submitted: do not apply again.'
            : closed
              ? 'This job is closed or unavailable.'
              : 'Verified profile answers ready for review. Real-site browser filling is not enabled yet.',
      });
    },
  );
  app.get('/applications', (_request, reply) =>
    reply
      .header(
        'content-security-policy',
        "default-src 'self'; connect-src 'self'; img-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'",
      )
      .header('cache-control', 'no-store')
      .type('text/html; charset=utf-8')
      .send(applicationsPageHtml),
  );

  app.get<{ Params: { userId: string } }>('/v1/applications/:userId', async (request, reply) => {
    const userId = z.uuid().safeParse(request.params.userId);
    if (!userId.success) return reply.code(400).send({ error: 'invalid_request' });
    const applications = await runtime.stores.applications.list(userId.data, 25);
    const rows = [];
    for (const application of applications) {
      const attempt = await runtime.stores.attempts.current(application.id);
      const open = await runtime.stores.questions.listOpen(application.id);
      const job = await runtime.tracking.tracking.detail(userId.data, application.jobId);
      rows.push({
        applicationId: application.id,
        jobTitle: job?.title ?? 'Unknown role',
        employer: job?.employer ?? 'Unknown employer',
        stage: application.state,
        pauseReason: application.pauseReason,
        attemptStatus: attempt?.status ?? null,
        openQuestions: open.length,
        takeoverRequested: application.takeoverRequestedAt !== null,
        updatedAt: application.updatedAt,
      });
    }
    return reply.header('cache-control', 'no-store').send({
      target: 'local fake ATS',
      realEmployerAutomation: false,
      autoSubmitEnabled: false,
      applications: rows,
    });
  });

  app.get<{ Params: { userId: string; applicationId: string } }>(
    '/v1/applications/:userId/:applicationId',
    async (request, reply) => {
      const userId = z.uuid().safeParse(request.params.userId);
      const applicationId = z.uuid().safeParse(request.params.applicationId);
      if (!userId.success || !applicationId.success) {
        return reply.code(400).send({ error: 'invalid_request' });
      }
      const overview = await runtime.workflow.overview(applicationId.data);
      if (overview?.application.userId !== userId.data) {
        return reply.code(404).send({ error: 'not_found' });
      }
      const job = await runtime.tracking.tracking.detail(userId.data, overview.application.jobId);
      const steps = runtime.adapter.steps.map((step) => ({
        id: step.id,
        humanOnly: step.humanOnly,
        completed: overview.attempt?.checkpoint?.completedStepIds.includes(step.id) ?? false,
        current: overview.attempt?.checkpoint?.currentStepId === step.id,
      }));
      return reply.header('cache-control', 'no-store').send({
        target: 'local fake ATS',
        realEmployerAutomation: false,
        autoSubmitEnabled: false,
        job: { title: job?.title ?? 'Unknown role', employer: job?.employer ?? 'Unknown employer' },
        application: {
          applicationId: overview.application.id,
          stage: overview.application.state,
          pauseReason: overview.application.pauseReason,
          takeoverRequested: overview.application.takeoverRequestedAt !== null,
          adapterId: overview.application.adapterId,
          adapterVersion: overview.application.adapterVersion,
        },
        attempt:
          overview.attempt === null
            ? null
            : {
                attemptNo: overview.attempt.attemptNo,
                status: overview.attempt.status,
                pauseReason: overview.attempt.pauseReason,
                manifestHash: overview.attempt.answerManifestHash,
              },
        steps,
        questions: overview.openQuestions.map((question) => ({
          questionId: question.id,
          stepId: question.stepId,
          fieldKey: question.fieldKey,
          reason: question.reason,
          prompt: question.prompt,
          responseKind: question.responseKind,
          allowedValues: question.allowedValues,
          expiresAt: question.expiresAt,
        })),
        // Evidence references and previews. Sensitive fields never carry a preview or a hash.
        fields: overview.fields.map((field) => ({
          stepId: field.stepId,
          fieldKey: field.fieldKey,
          label: field.label,
          intent: field.mappedIntent,
          required: field.required,
          sensitive: field.sensitive,
          unknown: field.mappedIntent === 'unknown',
          source: field.answerSource,
          answerPreview: field.answerPreview,
          evidenceFactIds: field.evidenceFactIds,
          validationStatus: field.validationStatus,
          validationMessage: field.validationMessage,
        })),
        manifestHash: overview.manifestHash,
        approval:
          overview.approval === null
            ? null
            : {
                decision: overview.approval.decision,
                snapshotHash: overview.approval.snapshotHash,
                createdAt: overview.approval.createdAt,
                expiresAt: overview.approval.expiresAt,
                consumed: overview.approval.consumedAt !== null,
              },
        submission: {
          ledgerStatus: overview.ledgerStatus,
          confirmationReference: overview.receipt?.providerReference ?? null,
        },
        artifacts: overview.artifacts.map((artifact) => ({
          kind: artifact.kind,
          sha256: artifact.sha256,
          bytes: artifact.bytes,
          redacted: artifact.redacted,
        })),
      });
    },
  );

  app.post<{ Params: { userId: string; applicationId: string; questionId: string } }>(
    '/v1/applications/:userId/:applicationId/questions/:questionId/answer',
    async (request, reply) => {
      const applicationId = z.uuid().safeParse(request.params.applicationId);
      const questionId = z.uuid().safeParse(request.params.questionId);
      const body = answerSchema.safeParse(request.body);
      if (!applicationId.success || !questionId.success || !body.success) {
        return reply.code(400).send({ error: 'invalid_request' });
      }
      const question = await runtime.stores.questions.get(questionId.data);
      if (question?.applicationId !== applicationId.data) {
        return reply.code(404).send({ error: 'not_found' });
      }
      if (question.responseKind === 'human_action') {
        return reply.code(409).send({
          error: 'human_action_required',
          message:
            'This one has to be done by you in the browser. Use manual takeover, complete it, then resume.',
        });
      }
      const result = await runtime.stores.questions.answer({
        questionId: questionId.data,
        responseVersion: body.data.responseVersion,
        ciphertext: Buffer.from(
          JSON.stringify(
            runtime.cipher.encryptJson(
              body.data.value,
              associatedData(question.attemptId, question.fieldKey),
            ),
          ),
          'utf8',
        ),
        scope: body.data.saveToProfile ? 'save_to_profile' : 'application_only',
        now: new Date(),
      });
      return reply.send({
        applied: result.applied,
        state: result.question.state,
        message: result.applied
          ? 'Answer recorded for this application only.'
          : 'That answer was already recorded. Nothing was repeated.',
      });
    },
  );

  // Confirms that the user dealt with a human-only step themselves. Without this there is no way to
  // close a `human_action` question from the screens, and a run that pauses on a sensitive step,
  // CAPTCHA, one-time code or declaration can never be resumed. No answer value is accepted here:
  // the agent does not learn what was entered.
  app.post<{ Params: { userId: string; applicationId: string; questionId: string } }>(
    '/v1/applications/:userId/:applicationId/questions/:questionId/completed',
    async (request, reply) => {
      const applicationId = z.uuid().safeParse(request.params.applicationId);
      const questionId = z.uuid().safeParse(request.params.questionId);
      if (!applicationId.success || !questionId.success) {
        return reply.code(400).send({ error: 'invalid_request' });
      }
      const result = await runtime.workflow.confirmHumanStepCompleted({
        applicationId: applicationId.data,
        questionId: questionId.data,
      });
      if (!result.completed) {
        return reply
          .code(result.reason === 'unknown_question' ? 404 : 409)
          .send({ error: result.reason, message: result.message });
      }
      return reply.send({ completed: true, message: result.message });
    },
  );

  /**
   * Opens a fake-ATS session for an attempt that has none yet, and remembers it on the attempt so a
   * later advance resumes the same session rather than starting a second one.
   */
  async function sessionRefFor(attemptId: string, existing: string | null): Promise<string | null> {
    if (existing !== null && existing !== '') return existing;
    let response: Response;
    try {
      response = await fetch(`${runtime.fakeAtsOrigin}/apply/practice/start`, {
        method: 'POST',
        redirect: 'manual',
      });
    } catch {
      return null;
    }
    const location = response.headers.get('location');
    if (location === null) return null;
    const reference = location.split('/')[2] ?? '';
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(reference)) return null;
    await runtime.stores.attempts.setSessionRef(attemptId, reference, new Date());
    return reference;
  }

  function describe(outcome: RunOutcome): Record<string, unknown> {
    return {
      target: 'local fake ATS',
      realEmployerAutomation: false,
      autoSubmitEnabled: false,
      finishedSteps: outcome.finishedStepIds,
      pausedAt: outcome.pausedAt,
      pauseReason: outcome.pauseReason,
      refusal: outcome.refusal,
      reachedReview: outcome.reachedReview,
    };
  }

  /**
   * Runs the attempt until it pauses. Shared by start and advance so both behave identically once
   * an attempt exists. The runner stops at the first question, human-only step or refusal; it never
   * submits.
   */
  async function drive(
    drive_: ApplicationDrive,
    userId: string,
    applicationId: string,
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const attempt = await runtime.stores.attempts.current(applicationId);
    if (attempt === null) return { status: 404, body: { error: 'no_attempt' } };

    const open = await runtime.stores.questions.listOpen(applicationId);
    if (open.length > 0) {
      return {
        status: 409,
        body: {
          error: 'questions_open',
          message: `Answer the ${String(open.length)} open question(s) first; the agent will not guess.`,
        },
      };
    }

    const sessionRef = await sessionRefFor(attempt.id, attempt.sessionRef);
    if (sessionRef === null) {
      return {
        status: 502,
        body: {
          error: 'fake_ats_unavailable',
          message: 'The practice job site did not answer. Start it with "pnpm fake-ats".',
        },
      };
    }

    const outcome = await drive_.runner.runUntilPause({
      attemptId: attempt.id,
      startUrl: `${runtime.fakeAtsOrigin}/apply/${sessionRef}/details`,
      facts: await drive_.loadFacts(userId),
      approvedDocument: await drive_.loadApprovedDocument(userId),
      sitePolicy: {
        origin: runtime.fakeAtsOrigin,
        applyMode: 'manual_only',
        submitPermitted: false,
      },
      correlationId: newCorrelationId(),
    });
    return { status: 200, body: { applicationId, ...describe(outcome) } };
  }

  app.post<{ Params: { userId: string } }>(
    '/v1/applications/:userId/start',
    async (request, reply) => {
      const userId = z.uuid().safeParse(request.params.userId);
      const body = startSchema.safeParse(request.body);
      if (!userId.success || !body.success)
        return reply.code(400).send({ error: 'invalid_request' });

      const driving = runtime.drive;
      if (driving === undefined || driving === null) {
        return reply.code(503).send({
          error: 'driving_unavailable',
          message: 'This build cannot drive the practice job site.',
        });
      }

      const job = await runtime.tracking.tracking.detail(userId.data, body.data.jobId);
      if (job === null) return reply.code(404).send({ error: 'unknown_job' });
      if (
        (await runtime.stores.applications.externalSubmission(userId.data, body.data.jobId)) !==
        null
      ) {
        return reply.code(409).send({ error: 'already_submitted' });
      }

      // Idempotent by job: a second start returns the running attempt rather than creating another.
      await runtime.workflow.startAttempt({
        userId: userId.data,
        jobId: body.data.jobId,
        matchRunId: null,
        policyVersion: driving.policyVersion,
        targetOrigin: runtime.fakeAtsOrigin,
      });
      const application = await runtime.stores.applications.findByJob(userId.data, body.data.jobId);
      if (application === null) return reply.code(500).send({ error: 'application_missing' });

      const result = await drive(driving, userId.data, application.id);
      return reply.code(result.status).header('cache-control', 'no-store').send(result.body);
    },
  );

  app.post<{ Params: { userId: string; applicationId: string } }>(
    '/v1/applications/:userId/:applicationId/advance',
    async (request, reply) => {
      const userId = z.uuid().safeParse(request.params.userId);
      const applicationId = z.uuid().safeParse(request.params.applicationId);
      if (!userId.success || !applicationId.success) {
        return reply.code(400).send({ error: 'invalid_request' });
      }
      const driving = runtime.drive;
      if (driving === undefined || driving === null) {
        return reply.code(503).send({
          error: 'driving_unavailable',
          message: 'This build cannot drive the practice job site.',
        });
      }
      const application = await runtime.stores.applications.get(applicationId.data);
      if (application?.userId !== userId.data) {
        return reply.code(404).send({ error: 'unknown_application' });
      }
      const result = await drive(driving, userId.data, applicationId.data);
      return reply.code(result.status).header('cache-control', 'no-store').send(result.body);
    },
  );

  app.post<{ Params: { userId: string; applicationId: string } }>(
    '/v1/applications/:userId/:applicationId/review',
    async (request, reply) => {
      const applicationId = z.uuid().safeParse(request.params.applicationId);
      const body = reviewSchema.safeParse(request.body);
      if (!applicationId.success || !body.success) {
        return reply.code(400).send({ error: 'invalid_request' });
      }
      const attempt = await runtime.stores.attempts.current(applicationId.data);
      if (attempt === null) return reply.code(404).send({ error: 'no_attempt' });
      const { manifest, hash } = await runtime.workflow.buildManifest({
        applicationId: applicationId.data,
        attemptId: attempt.id,
        jobId: body.data.jobId,
        jobVersion: body.data.jobVersion,
        cvDocumentId: body.data.cvDocumentId,
        cvSha256: body.data.cvSha256,
      });
      return reply.header('cache-control', 'no-store').send({ manifest, manifestHash: hash });
    },
  );

  app.post<{ Params: { userId: string; applicationId: string } }>(
    '/v1/applications/:userId/:applicationId/decision',
    async (request, reply) => {
      const applicationId = z.uuid().safeParse(request.params.applicationId);
      const body = decisionSchema.safeParse(request.body);
      if (!applicationId.success || !body.success) {
        return reply.code(400).send({ error: 'invalid_request' });
      }
      const attempt = await runtime.stores.attempts.current(applicationId.data);
      if (attempt === null) return reply.code(404).send({ error: 'no_attempt' });
      if (attempt.answerManifestHash !== body.data.manifestHash) {
        return reply.code(409).send({
          error: 'stale_manifest',
          message:
            'The answers have changed since that review was shown. Open the review again and check it before approving.',
        });
      }
      try {
        const result = await runtime.workflow.recordDecision({
          applicationId: applicationId.data,
          attemptId: attempt.id,
          snapshotHash: body.data.manifestHash,
          decision: body.data.decision,
          reason: body.data.reason ?? null,
          correlationId: newCorrelationId(),
        });
        return await reply.send({
          recorded: result.created,
          stage: result.state.state,
          message: result.created
            ? `Recorded: ${body.data.decision}.`
            : 'That decision was already recorded. Nothing was repeated.',
        });
      } catch (error) {
        return await reply.code(409).send({
          error: 'decision_rejected',
          message: error instanceof Error ? error.message : 'That decision was not allowed.',
        });
      }
    },
  );

  app.post<{ Params: { userId: string; applicationId: string } }>(
    '/v1/applications/:userId/:applicationId/takeover',
    async (request, reply) => {
      const applicationId = z.uuid().safeParse(request.params.applicationId);
      if (!applicationId.success) return reply.code(400).send({ error: 'invalid_request' });
      const state = await runtime.workflow.requestTakeover({ applicationId: applicationId.data });
      return reply.send({
        stage: state.state,
        takeoverRequested: state.takeoverRequestedAt !== null,
        message:
          'The agent has stopped. Complete the step yourself in the browser, then choose Resume.',
      });
    },
  );

  app.post<{ Params: { userId: string; applicationId: string } }>(
    '/v1/applications/:userId/:applicationId/resume',
    async (request, reply) => {
      const applicationId = z.uuid().safeParse(request.params.applicationId);
      if (!applicationId.success) return reply.code(400).send({ error: 'invalid_request' });
      try {
        const result = await runtime.workflow.resume({ applicationId: applicationId.data });
        return await reply.send({
          resumed: result.resumed,
          stage: result.state.state,
          message: result.message,
        });
      } catch (error) {
        return await reply.code(409).send({
          error: 'resume_rejected',
          message:
            error instanceof Error ? error.message : 'That application could not be resumed.',
        });
      }
    },
  );
}

/**
 * The Discord surface's view of an application. It can read state and record workflow intent, and
 * it deliberately exposes no applicant answer.
 */
export function createApplicationCommandPort(
  runtime: ApplicationRuntime,
  userId: string,
): ApplicationCommandPort {
  const findApplication = async (idPrefix: string) => {
    const applications = await runtime.stores.applications.list(userId, 50);
    return applications.find((application) => application.id.startsWith(idPrefix)) ?? null;
  };

  const summarise = async (applicationId: string): Promise<ApplicationSummaryView | null> => {
    const overview = await runtime.workflow.overview(applicationId);
    if (overview === null) return null;
    const job = await runtime.tracking.tracking.detail(userId, overview.application.jobId);
    return {
      applicationId: overview.application.id,
      jobTitle: job?.title ?? 'Unknown role',
      employer: job?.employer ?? 'Unknown employer',
      stage: overview.application.state,
      attemptStatus: overview.attempt?.status ?? null,
      pauseReason: overview.application.pauseReason,
      openQuestions: overview.openQuestions.length,
      manifestHashPrefix:
        overview.manifestHash === null ? null : overview.manifestHash.slice(0, 12),
      approvalState:
        overview.approval === null
          ? 'none'
          : overview.approval.consumedAt !== null
            ? 'consumed'
            : overview.approval.decision,
      confirmationReference: overview.receipt?.providerReference ?? null,
      takeoverRequested: overview.application.takeoverRequestedAt !== null,
    };
  };

  return {
    list: async (limit) => {
      const applications = await runtime.stores.applications.list(userId, limit);
      const rows: ApplicationSummaryView[] = [];
      for (const application of applications) {
        const summary = await summarise(application.id);
        if (summary !== null) rows.push(summary);
      }
      return rows;
    },

    show: async (idPrefix) => {
      const application = await findApplication(idPrefix);
      return application === null ? null : summarise(application.id);
    },

    currentQuestion: async (idPrefix): Promise<PausedQuestionView | null> => {
      const application = await findApplication(idPrefix);
      if (application === null) return null;
      const open = await runtime.stores.questions.listOpen(application.id);
      const question = open[0];
      if (question === undefined) return null;
      return {
        questionId: question.id,
        applicationId: application.id,
        prompt: question.prompt,
        reason: question.reason,
        responseKind: question.responseKind,
        allowedValues: question.allowedValues,
      };
    },

    answer: async (input): Promise<CommandResult> => {
      const application = await findApplication(input.idPrefix);
      if (application === null) return { ok: false, message: 'I could not find that application.' };
      const open = await runtime.stores.questions.listOpen(application.id);
      const question = open[0];
      if (question === undefined) {
        return { ok: false, message: 'Nothing is waiting for you on that application.' };
      }
      if (question.responseKind === 'human_action') {
        return {
          ok: false,
          message:
            'That step has to be done by you in the browser. Use /application takeover, complete it, then /application resume.',
        };
      }
      if (question.allowedValues.length > 0 && !question.allowedValues.includes(input.value)) {
        return {
          ok: false,
          message: `The form only offers: ${question.allowedValues.join(', ')}.`,
        };
      }
      const result = await runtime.stores.questions.answer({
        questionId: question.id,
        // The Discord interaction id has already been consumed once by the inbox, so a replay
        // arrives with the same response version and is ignored here too.
        responseVersion: question.responseVersion + 1,
        ciphertext: Buffer.from(
          JSON.stringify(
            runtime.cipher.encryptJson(
              input.value,
              associatedData(question.attemptId, question.fieldKey),
            ),
          ),
          'utf8',
        ),
        scope: input.saveToProfile ? 'save_to_profile' : 'application_only',
        now: new Date(),
      });
      return {
        ok: result.applied,
        message: result.applied
          ? 'Answer recorded for this application only. Nothing was sent to an employer.'
          : 'That answer was already recorded. Nothing was repeated.',
      };
    },

    decide: async (input): Promise<CommandResult> => {
      const application = await findApplication(input.idPrefix);
      if (application === null) return { ok: false, message: 'I could not find that application.' };
      const attempt = await runtime.stores.attempts.current(application.id);
      const manifestHash = attempt?.answerManifestHash ?? null;
      if (attempt === null || manifestHash === null) {
        return { ok: false, message: 'There is no review to approve yet.' };
      }
      if (input.decision === 'approved' && !manifestHash.startsWith(input.manifestHashPrefix)) {
        return {
          ok: false,
          message:
            'That review reference does not match the current answers. Open the applications page, check the review again, and use the reference it shows.',
        };
      }
      try {
        const result = await runtime.workflow.recordDecision({
          applicationId: application.id,
          attemptId: attempt.id,
          snapshotHash: manifestHash,
          decision: input.decision,
          reason: input.reason,
          correlationId: newCorrelationId(),
        });
        return {
          ok: true,
          message: result.created
            ? `Recorded: ${input.decision}. This is the local fake ATS; nothing goes to an employer.`
            : 'That decision was already recorded. Nothing was repeated.',
        };
      } catch (error) {
        return {
          ok: false,
          message: error instanceof Error ? error.message : 'That decision was not allowed.',
        };
      }
    },

    requestTakeover: async (idPrefix): Promise<CommandResult> => {
      const application = await findApplication(idPrefix);
      if (application === null) return { ok: false, message: 'I could not find that application.' };
      await runtime.workflow.requestTakeover({ applicationId: application.id });
      return {
        ok: true,
        message:
          'The agent has stopped on that application. Complete the step yourself in the browser, then use /application resume.',
      };
    },

    resume: async (idPrefix): Promise<CommandResult> => {
      const application = await findApplication(idPrefix);
      if (application === null) return { ok: false, message: 'I could not find that application.' };
      const result = await runtime.workflow.resume({ applicationId: application.id });
      return { ok: result.resumed, message: result.message };
    },
  };
}
