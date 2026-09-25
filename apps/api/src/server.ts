import Fastify, { type FastifyInstance } from 'fastify';
import { z } from 'zod';

import { fetchMyJobScotlandJob, type DiscoveredJob } from '@job-agent/discovery';
import { findMissingProfileCategories } from '@job-agent/knowledge-base';
import { shadowMatch } from '@job-agent/matching';
import type { CvProcessingService, DocumentService, ProfileService } from '@job-agent/profile';
import { secureTokenEquals } from '@job-agent/security';

import { cvReviewPageHtml } from './cv-review-page.js';
import { onboardingPageHtml } from './onboarding-page.js';
import { shadowMatchPageHtml } from './shadow-match-page.js';
import { registerApplicationRoutes, type ApplicationRuntime } from './application-routes.js';
import { trackerPageHtml } from './tracker-page.js';
import { registerTrackerRoutes, type TrackingRuntime } from './tracker-routes.js';

const userFactInputSchema = z.object({
  userId: z.uuid(),
  key: z
    .string()
    .min(1)
    .regex(/^[a-z][a-z0-9_.-]*$/),
  value: z.unknown(),
  confirmed: z.literal(true),
  sensitivity: z.enum(['normal', 'personal', 'high_risk']),
  usePolicy: z.enum(['auto_fill', 'ask_each_time', 'never_auto_fill']),
  allowedPurposes: z.array(z.enum(['matching', 'application', 'reporting'])).min(1),
});

const createUserInputSchema = z.object({
  timezone: z.string().min(1).default('Europe/London'),
});

const cvUploadSchema = z.object({
  userId: z.uuid(),
  fileName: z.string().min(1).max(200),
  mimeType: z.enum([
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  ]),
  dataBase64: z
    .string()
    .min(1)
    .max(7_000_000)
    .regex(/^[A-Za-z0-9+/]+={0,2}$/),
  confirmed: z.literal(true),
});

const cvProcessSchema = z.object({ userId: z.uuid() });
const reviewedSectionsSchema = z.object({
  employment: z.string().max(100_000),
  education: z.string().max(100_000),
  skills: z.string().max(100_000),
  qualifications: z.string().max(100_000),
});
const cvApprovalSchema = z.object({
  userId: z.uuid(),
  documentId: z.uuid(),
  expectedSha256: z.string().regex(/^[a-f0-9]{64}$/),
  confirmed: z.literal(true),
  reviewedSections: reviewedSectionsSchema,
});
const shadowMatchSchema = z.object({ userId: z.uuid(), url: z.url() });

export type BuildServerOptions = {
  profileService: ProfileService;
  documentService: DocumentService;
  cvProcessingService: CvProcessingService;
  myJobScotlandFetcher?: (url: string) => Promise<DiscoveredJob>;
  tracking?: TrackingRuntime;
  applications?: ApplicationRuntime;
  adminToken: string;
  logger?: boolean;
};

const localPagePaths = new Set([
  '/onboarding',
  '/cv-review',
  '/shadow-match',
  '/tracker',
  '/applications',
]);
const unauthenticatedApiPaths = new Set(['/health', '/v1/discord/interactions']);

const localPageCsp =
  "default-src 'self'; connect-src 'self'; img-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'";

function bearerToken(header: string | undefined): string | null {
  if (!header?.startsWith('Bearer ')) return null;
  return header.slice('Bearer '.length);
}

export function buildServer(options: BuildServerOptions): FastifyInstance {
  if (options.adminToken.length < 32)
    throw new Error('PROFILE_ADMIN_TOKEN must be at least 32 characters');
  const app = Fastify({
    logger:
      options.logger === true
        ? { redact: ['req.headers.authorization', 'headers.authorization'] }
        : false,
    bodyLimit: 8 * 1024 * 1024,
  });

  // Discord interaction signatures cover the exact bytes received, so the raw body is retained.
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'string' },
    (request, body, done: (error: Error | null, result?: unknown) => void) => {
      const raw = typeof body === 'string' ? body : body.toString('utf8');
      (request as typeof request & { rawBody?: string }).rawBody = raw;
      if (raw.trim() === '') {
        done(null, {});
        return;
      }
      try {
        done(null, JSON.parse(raw));
      } catch (error) {
        done(error instanceof Error ? error : new Error('invalid_json'), undefined);
      }
    },
  );

  app.addHook('onRequest', async (request, reply) => {
    const pathname = request.url.split('?', 1)[0] ?? '';
    if (unauthenticatedApiPaths.has(pathname) || localPagePaths.has(pathname)) return;
    const provided = bearerToken(request.headers.authorization);
    if (provided === null || !secureTokenEquals(provided, options.adminToken)) {
      await reply.code(401).send({ error: 'unauthorised' });
    }
  });

  app.get('/health', async () => {
    const tracking = options.tracking;
    if (tracking === undefined) {
      return {
        status: 'ok',
        browserAutomation: options.applications === undefined ? false : 'fake_ats_only',
        productionApplicationAutomation: false,
        autoSubmit: false,
      };
    }
    const runtime = await tracking.stores.runtime.get();
    const schedulerStatus = tracking.scheduler?.status() ?? null;
    return {
      status: 'ok',
      browserAutomation: options.applications === undefined ? false : 'fake_ats_only',
      productionApplicationAutomation: false,
      autoSubmit: false,
      paused: runtime.paused,
      notificationsConfigured: tracking.notificationsConfigured,
      schedulerConfigured: tracking.schedulerEnabled ?? false,
      schedulerReady: schedulerStatus?.ready ?? false,
      pendingNotifications: await tracking.stores.outbox.pendingCount(new Date()),
      undeliverableNotifications: (await tracking.stores.outbox.deadLetters(1)).length,
    };
  });

  app.get('/onboarding', (_request, reply) =>
    reply
      .header(
        'content-security-policy',
        "default-src 'self'; connect-src 'self'; img-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'",
      )
      .header('cache-control', 'no-store')
      .type('text/html; charset=utf-8')
      .send(onboardingPageHtml),
  );

  app.get('/cv-review', (_request, reply) =>
    reply
      .header(
        'content-security-policy',
        "default-src 'self'; connect-src 'self'; img-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'",
      )
      .header('cache-control', 'no-store')
      .type('text/html; charset=utf-8')
      .send(cvReviewPageHtml),
  );

  app.get('/shadow-match', (_request, reply) =>
    reply
      .header('content-security-policy', localPageCsp)
      .header('cache-control', 'no-store')
      .type('text/html; charset=utf-8')
      .send(shadowMatchPageHtml),
  );

  app.get('/tracker', (_request, reply) =>
    reply
      .header('content-security-policy', localPageCsp)
      .header('cache-control', 'no-store')
      .type('text/html; charset=utf-8')
      .send(trackerPageHtml),
  );

  app.get('/v1/onboarding/requirements', () => ({
    collectNow: [
      'CV document reference',
      'target roles',
      'location and work-pattern preferences',
      'minimum salary',
      'contract type and hours',
      'employment and education history',
      'skills and qualifications',
      'work authorisation and sponsorship',
      'notice period',
    ],
    collectOnlyWhenRequired: [
      'diversity information',
      'health or disability disclosure',
      'criminal-record information',
      'background-check consent',
      'legal declarations',
    ],
    neverCollect: ['banking credentials', 'email password', 'Discord password'],
  }));

  app.post('/v1/profile/users', async (request, reply) => {
    const parsed = createUserInputSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });
    return reply.code(201).send(await options.profileService.createUser(parsed.data.timezone));
  });

  app.post('/v1/profile/facts', async (request, reply) => {
    const parsed = userFactInputSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_request', issues: parsed.error.issues });
    }
    const fact = await options.profileService.addConfirmedUserFact(parsed.data);
    return reply.code(201).send({
      id: fact.id,
      key: fact.key,
      status: fact.status,
      sensitivity: fact.sensitivity,
      usePolicy: fact.usePolicy,
      allowedPurposes: fact.allowedPurposes,
      version: fact.version,
      verifiedAt: fact.verifiedAt,
    });
  });

  app.post('/v1/profile/documents/cv', async (request, reply) => {
    const parsed = cvUploadSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_cv_upload', issues: parsed.error.issues });
    }
    const bytes = Buffer.from(parsed.data.dataBase64, 'base64');
    try {
      const document = await options.documentService.uploadCv({
        userId: parsed.data.userId,
        fileName: parsed.data.fileName,
        mimeType: parsed.data.mimeType,
        bytes,
        confirmed: parsed.data.confirmed,
      });
      return await reply.code(202).send({
        ...document,
        message: 'CV encrypted and quarantined pending safety scan and approval',
      });
    } catch (error) {
      return await reply.code(400).send({
        error: 'cv_upload_rejected',
        message: error instanceof Error ? error.message : 'CV upload rejected',
      });
    } finally {
      bytes.fill(0);
    }
  });

  app.post('/v1/profile/documents/cv/process', async (request, reply) => {
    const parsed = cvProcessSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });
    try {
      const review = await options.cvProcessingService.processLatest(parsed.data.userId);
      return await reply.header('cache-control', 'no-store').send(review);
    } catch (error) {
      return await reply.code(400).send({
        error: 'cv_processing_failed',
        message: error instanceof Error ? error.message : 'CV processing failed',
      });
    }
  });

  app.post('/v1/profile/documents/cv/approve', async (request, reply) => {
    const parsed = cvApprovalSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });
    try {
      const document = await options.cvProcessingService.approve(parsed.data);
      await options.profileService.addConfirmedUserFact({
        userId: parsed.data.userId,
        key: 'documents.cv',
        value: {
          documentId: document.id,
          version: document.version,
          sha256: document.sha256,
          mimeType: document.mimeType,
        },
        confirmed: true,
        sensitivity: 'personal',
        usePolicy: 'auto_fill',
        allowedPurposes: ['matching', 'application'],
      });
      const reviewedFactKeys = {
        employment: 'employment.cv_reviewed_text',
        education: 'education.cv_reviewed_text',
        skills: 'skills.cv_reviewed_text',
        qualifications: 'certifications_licences.cv_reviewed_text',
      } as const;
      for (const section of Object.keys(reviewedFactKeys) as Array<keyof typeof reviewedFactKeys>) {
        const sectionValue = parsed.data.reviewedSections[section].trim();
        if (sectionValue === '') continue;
        await options.profileService.addConfirmedUserFact({
          userId: parsed.data.userId,
          key: reviewedFactKeys[section],
          value: sectionValue,
          confirmed: true,
          sensitivity: 'normal',
          usePolicy: 'auto_fill',
          allowedPurposes: ['matching', 'application'],
        });
      }
      const facts = await options.profileService.listFacts(parsed.data.userId);
      const missingCategories = findMissingProfileCategories(facts);
      return await reply.send({
        documentId: document.id,
        readyForMatching: missingCategories.length === 0,
        missingCategories,
      });
    } catch (error) {
      return await reply.code(400).send({
        error: 'cv_approval_failed',
        message: error instanceof Error ? error.message : 'CV approval failed',
      });
    }
  });

  app.get<{ Params: { userId: string } }>('/v1/profile/:userId/facts', async (request, reply) => {
    const userId = z.uuid().safeParse(request.params.userId);
    if (!userId.success) return reply.code(400).send({ error: 'invalid_user_id' });
    return { facts: await options.profileService.listFacts(userId.data) };
  });

  app.get<{ Params: { userId: string } }>(
    '/v1/profile/:userId/readiness',
    async (request, reply) => {
      const userId = z.uuid().safeParse(request.params.userId);
      if (!userId.success) return reply.code(400).send({ error: 'invalid_user_id' });
      const facts = await options.profileService.listFacts(userId.data);
      const missingCategories = findMissingProfileCategories(facts);
      return { readyForMatching: missingCategories.length === 0, missingCategories };
    },
  );

  app.post('/v1/shadow-match/myjobscotland', async (request, reply) => {
    const parsed = shadowMatchSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });
    try {
      const facts = await options.profileService.listFacts(parsed.data.userId);
      const missingCategories = findMissingProfileCategories(facts);
      if (missingCategories.length > 0) {
        return await reply.code(409).send({
          error: 'profile_not_ready',
          message: 'Finish and approve the applicant profile before checking jobs.',
          missingCategories,
        });
      }
      const job = await (options.myJobScotlandFetcher ?? fetchMyJobScotlandJob)(parsed.data.url);
      const result = shadowMatch(
        {
          id: job.externalId,
          title: job.title,
          employer: job.employer,
          location: job.location,
          description: job.description,
          salary: job.salary,
          contractType: job.contractType,
          employmentTypes: job.employmentTypes,
          workPattern: job.workPattern,
          closesAt: job.closesAt,
          ...(job.personSpecification === undefined
            ? {}
            : {
                personSpecification: {
                  status: job.personSpecification.status,
                  ...(job.personSpecification.status === 'read'
                    ? { text: job.personSpecification.text }
                    : {}),
                  ...(job.personSpecification.status === 'unreadable'
                    ? { reason: job.personSpecification.reason }
                    : {}),
                },
              }),
        },
        facts,
      );
      const salary =
        job.salary?.sourceText !== undefined && job.salary.sourceText !== ''
          ? job.salary.sourceText
          : job.salary?.minimumMinor === undefined
            ? null
            : `£${Math.round(job.salary.minimumMinor / 100).toLocaleString('en-GB')}`;
      return await reply.header('cache-control', 'no-store').send({
        mode: 'shadow_only',
        applicationActionsEnabled: false,
        job: {
          id: job.externalId,
          title: job.title,
          employer: job.employer,
          location: job.location,
          salary,
          closesAt: job.closesAt,
          url: job.canonicalUrl,
        },
        match: result.decision,
        salaryGate: result.salaryGate,
        criteria: result.criteria,
        signals: result.signals,
        requirements: result.requirements.map((requirement) => ({
          text: requirement.text,
          outcome: requirement.outcome,
          explanation: requirement.explanation,
        })),
      });
    } catch (error) {
      return await reply.code(400).send({
        error: 'job_check_failed',
        message: error instanceof Error ? error.message : 'The job could not be checked.',
      });
    }
  });

  if (options.tracking !== undefined) {
    registerTrackerRoutes(app, options.tracking, options.profileService);
  }

  if (options.applications !== undefined) {
    registerApplicationRoutes(app, options.applications);
  }

  app.setErrorHandler(async (error: Error, _request, reply) => {
    app.log.error({ err: { name: error.name, message: error.message } }, 'Request failed');
    await reply.code(500).send({ error: 'internal_error' });
  });

  return app;
}
