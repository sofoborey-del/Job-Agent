import Fastify, { type FastifyInstance } from 'fastify';

import { validateStep } from './form.js';
import { parseMultipart } from './multipart.js';
import { renderAmbiguous, renderConfirmation, renderStart, renderStep } from './render.js';
import { FakeAtsStore, type FakeAtsControl } from './state.js';

const stepOrder = [
  'details',
  'history',
  'documents',
  'questions',
  'checks',
  'declarations',
  'review',
] as const;
type StepId = (typeof stepOrder)[number];

function isStep(value: string): value is StepId {
  return (stepOrder as readonly string[]).includes(value);
}

export type FakeAtsOptions = {
  logger?: boolean;
  store?: FakeAtsStore;
};

/**
 * A synthetic multi-page application form used only to exercise the browser framework. It is not a
 * real employer or ATS, it accepts nothing but local traffic, and it never sends anything anywhere.
 */
export type FakeAtsApp = FastifyInstance & { store: FakeAtsStore };

export function buildFakeAts(options: FakeAtsOptions = {}): FakeAtsApp {
  const store = options.store ?? new FakeAtsStore();
  const app = Fastify({ logger: options.logger ?? false, bodyLimit: 8 * 1024 * 1024 });

  app.addContentTypeParser(
    'multipart/form-data',
    { parseAs: 'buffer' },
    (request, body, done: (error: Error | null, result?: unknown) => void) => {
      try {
        done(null, parseMultipart(body as Buffer, request.headers['content-type'] ?? ''));
      } catch (error) {
        done(error instanceof Error ? error : new Error('bad multipart'), undefined);
      }
    },
  );

  const pause = async (): Promise<void> => {
    if (store.control.delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, store.control.delayMs));
    }
  };

  const html = (body: string): { body: string; type: string } => ({
    body,
    type: 'text/html; charset=utf-8',
  });

  app.get('/health', () => ({ status: 'ok', software: 'fake-ats', realEmployer: false }));

  app.post('/__control', async (request, reply) => {
    const body = (request.body ?? {}) as Partial<FakeAtsControl> & { reset?: boolean };
    if (body.reset === true) store.reset();
    store.control = {
      ...store.control,
      ...(body.validationOnFirstAttempt === undefined
        ? {}
        : { validationOnFirstAttempt: body.validationOnFirstAttempt }),
      ...(body.delayMs === undefined ? {} : { delayMs: body.delayMs }),
      ...(body.failOnStep === undefined ? {} : { failOnStep: body.failOnStep }),
      ...(body.submitOutcome === undefined ? {} : { submitOutcome: body.submitOutcome }),
      ...(body.requireExtraFieldOnReview === undefined
        ? {}
        : { requireExtraFieldOnReview: body.requireExtraFieldOnReview }),
    };
    return reply.send(store.control);
  });

  app.get<{ Params: { sessionId: string } }>('/__state/:sessionId', async (request, reply) => {
    const session = store.get(request.params.sessionId);
    if (session === null) return reply.code(404).send({ error: 'unknown_session' });
    return reply.send(session);
  });

  app.get<{ Params: { jobRef: string } }>('/apply/:jobRef', async (request, reply) => {
    const page = html(renderStart(request.params.jobRef));
    return reply.type(page.type).send(page.body);
  });

  app.post<{ Params: { jobRef: string } }>('/apply/:jobRef/start', async (request, reply) => {
    await pause();
    const session = store.create(request.params.jobRef);
    return reply.redirect(`/apply/${session.id}/details`, 303);
  });

  app.get<{ Params: { sessionId: string; stepId: string } }>(
    '/apply/:sessionId/:stepId',
    async (request, reply) => {
      const session = store.get(request.params.sessionId);
      if (session === null) return reply.code(404).send('unknown session');
      const { stepId } = request.params;
      if (stepId === 'confirmation') {
        if (session.reference === null) return reply.code(404).send('not submitted');
        const page = html(renderConfirmation(session));
        return reply.type(page.type).send(page.body);
      }
      if (!isStep(stepId)) return reply.code(404).send('unknown step');
      await pause();
      const page = html(
        renderStep({
          session,
          stepId,
          errors: [],
          extraReviewField: store.control.requireExtraFieldOnReview,
          isLastStep: stepId === 'review',
        }),
      );
      return reply.type(page.type).send(page.body);
    },
  );

  app.post<{ Params: { sessionId: string; stepId: string } }>(
    '/apply/:sessionId/:stepId',
    async (request, reply) => {
      const session = store.get(request.params.sessionId);
      if (session === null) return reply.code(404).send('unknown session');
      const { stepId } = request.params;
      if (!isStep(stepId)) return reply.code(404).send('unknown step');
      await pause();

      if (store.control.failOnStep === stepId) {
        return reply.code(500).send('the fake ATS was asked to fail on this step');
      }

      const parsed = (request.body ?? { fields: {}, files: {} }) as {
        fields: Record<string, string>;
        files: Record<
          string,
          {
            fieldName: string;
            filename: string;
            bytes: number;
            sha256: string;
            contentType: string;
          }
        >;
      };
      const fields = parsed.fields;
      const files = parsed.files;

      if (fields.__action === 'add_employment' || fields.__action === 'add_education') {
        for (const [key, value] of Object.entries(fields)) {
          if (key !== '__action') session.values[key] = value;
        }
        if (fields.__action === 'add_employment') session.employmentRows += 1;
        else session.educationRows += 1;
        return reply.redirect(`/apply/${session.id}/history`, 303);
      }

      const attempts = (session.stepAttempts[stepId] ?? 0) + 1;
      session.stepAttempts[stepId] = attempts;

      const errors = validateStep(
        stepId,
        session,
        fields,
        files,
        store.control.requireExtraFieldOnReview,
      );
      if (store.control.validationOnFirstAttempt && attempts === 1 && stepId !== 'review') {
        errors.push('The form rejected this attempt. Please check your answers and try again.');
      }

      if (errors.length > 0) {
        for (const [key, value] of Object.entries(fields)) {
          if (key !== '__action') session.values[key] = value;
        }
        const page = html(
          renderStep({
            session,
            stepId,
            errors,
            extraReviewField: store.control.requireExtraFieldOnReview,
            isLastStep: stepId === 'review',
          }),
        );
        return reply.code(200).type(page.type).send(page.body);
      }

      for (const [key, value] of Object.entries(fields)) {
        if (key !== '__action') session.values[key] = value;
      }
      for (const [key, file] of Object.entries(files)) session.files[key] = file;
      if (!session.completedSteps.includes(stepId)) session.completedSteps.push(stepId);

      if (stepId === 'review') {
        if (store.control.submitOutcome === 'error') {
          return reply.code(502).send('the fake ATS was asked to fail the submission');
        }
        store.recordSubmission(session);
        if (store.control.submitOutcome === 'ambiguous') {
          const page = html(renderAmbiguous());
          return reply.code(200).type(page.type).send(page.body);
        }
        return reply.redirect(`/apply/${session.id}/confirmation`, 303);
      }

      const index = stepOrder.indexOf(stepId);
      const next = stepOrder[index + 1] ?? 'review';
      return reply.redirect(`/apply/${session.id}/${next}`, 303);
    },
  );

  return Object.assign(app, { store });
}
