import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import type { ApplicationStores, ApplicationWorkflowService } from '@job-agent/application';
import type { AdapterContract } from '@job-agent/browser-core';
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

export type ApplicationRuntime = {
  stores: ApplicationStores;
  tracking: TrackingStores;
  workflow: ApplicationWorkflowService;
  adapter: AdapterContract;
  cipher: FieldCipher;
  fakeAtsOrigin: string;
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
