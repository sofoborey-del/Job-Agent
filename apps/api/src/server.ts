import { createHash } from 'node:crypto';

import Fastify, { type FastifyInstance } from 'fastify';
import { z } from 'zod';

import { fetchMyJobScotlandJob, type DiscoveredJob } from '@job-agent/discovery';
import { findMissingProfileCategories } from '@job-agent/knowledge-base';
import { shadowMatch } from '@job-agent/matching';
import { applyLeavingReasonLinks, draftHistoryFromReviewedCv, draftLeavingReasonLinks, type CvProcessingService, type DocumentService, type EmploymentRowRef, type LeavingReasonRecord, type ProfileService } from '@job-agent/profile';
import { secureTokenEquals } from '@job-agent/security';

import { cvReviewPageHtml } from './cv-review-page.js';
import { applicationPrepPageHtml } from './application-prep-page.js';
import { leavingReasonsPageHtml } from './leaving-reasons-page.js';
import { onboardingPageHtml } from './onboarding-page.js';
import { profileHistoryPageHtml } from './profile-history-page.js';
import { shadowMatchPageHtml } from './shadow-match-page.js';
import { registerApplicationRoutes, type ApplicationRuntime } from './application-routes.js';
import { trackerPageHtml } from './tracker-page.js';
import { answerTopicFactKey, answerTopicIsSensitive, answerTopicSchema, answerTopics, storedAnswerSchema } from './answer-vault.js';
import { answerVaultPageHtml } from './answer-vault-page.js';
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
const historyRowSchema = z.object({
  employer: z.string().trim().min(1).max(300),
  title: z.string().trim().min(1).max(300),
  startDate: z.string().trim().min(1).max(80).nullable(),
  endDate: z.string().trim().min(1).max(80).nullable(),
  evidenceSummary: z.string().trim().min(1).max(10_000).nullable(),
});
const educationRowSchema = z.object({
  institution: z.string().trim().min(1).max(300),
  qualification: z.string().trim().min(1).max(300),
  field: z.string().trim().min(1).max(300).nullable(),
  startDate: z.string().trim().min(1).max(80).nullable(),
  endDate: z.string().trim().min(1).max(80).nullable(),
  grade: z.string().trim().min(1).max(120).nullable(),
});
const historyConfirmationSchema = z.object({
  sourceRevision: z.string().min(3).max(200),
  employment: z.array(historyRowSchema).min(1).max(50),
  education: z.array(educationRowSchema).min(1).max(50),
  confirmed: z.literal(true),
});

async function reviewedHistoryTexts(service: ProfileService, userId: string) {
  const facts = await service.listFacts(userId);
  const employment = facts.find((fact) => fact.key === 'employment.cv_reviewed_text');
  const education = facts.find((fact) => fact.key === 'education.cv_reviewed_text');
  if (
    employment?.status !== 'verified' || education?.status !== 'verified' ||
    typeof employment.value !== 'string' || typeof education.value !== 'string'
  ) return null;
  return { employment, education, facts, sourceRevision: `${employment.id}:${education.id}` };
}

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
  '/profile-history',
  '/answer-vault',
  '/shadow-match',
  '/tracker',
  '/applications',
  '/application-prep',
  '/leaving-reasons',
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

  app.get('/profile-history', (_request, reply) =>
    reply.header('content-security-policy', localPageCsp)
      .header('cache-control', 'no-store')
      .type('text/html; charset=utf-8')
      .send(profileHistoryPageHtml),
  );

  app.get('/answer-vault', (_request, reply) =>
    reply.header('content-security-policy', localPageCsp)
      .header('cache-control', 'no-store')
      .type('text/html; charset=utf-8')
      .send(answerVaultPageHtml),
  );

  app.get('/application-prep', (_request, reply) =>
    reply
      .header('content-security-policy', localPageCsp)
      .header('cache-control', 'no-store')
      .type('text/html; charset=utf-8')
      .send(applicationPrepPageHtml),
  );

  app.get('/leaving-reasons', (_request, reply) =>
    reply
      .header('content-security-policy', localPageCsp)
      .header('cache-control', 'no-store')
      .type('text/html; charset=utf-8')
      .send(leavingReasonsPageHtml),
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

  app.get<{ Params: { userId: string } }>('/v1/profile/:userId/history-draft', async (request, reply) => {
    const userId = z.uuid().safeParse(request.params.userId);
    if (!userId.success) return reply.code(400).send({ error: 'invalid_user_id' });
    const reviewed = await reviewedHistoryTexts(options.profileService, userId.data);
    if (reviewed === null) return reply.code(409).send({ error: 'reviewed_cv_sections_missing', message: 'Review and approve your CV sections first.' });
    const draft = draftHistoryFromReviewedCv(reviewed.employment.value as string, reviewed.education.value as string);
    return reply.header('cache-control', 'no-store').send({ ...draft, sourceRevision: reviewed.sourceRevision });
  });

  app.post<{ Params: { userId: string } }>('/v1/profile/:userId/history-confirm', async (request, reply) => {
    const userId = z.uuid().safeParse(request.params.userId);
    const body = historyConfirmationSchema.safeParse(request.body);
    if (!userId.success || !body.success) return reply.code(400).send({ error: 'invalid_request' });
    const reviewed = await reviewedHistoryTexts(options.profileService, userId.data);
    if (reviewed?.sourceRevision !== body.data.sourceRevision) {
      return reply.code(409).send({ error: 'cv_review_changed', message: 'The reviewed CV changed. Reload and check the draft again.' });
    }
    const entries = [
      ['employment.history', body.data.employment],
      ['education.history', body.data.education],
    ] as const;
    const updated: string[] = [];
    for (const [key, value] of entries) {
      const current = reviewed.facts.find((fact) => fact.key === key);
      if (JSON.stringify(current?.value) === JSON.stringify(value)) continue;
      await options.profileService.addConfirmedUserFact({
        userId: userId.data, key, value, confirmed: true,
        sensitivity: 'normal', usePolicy: 'auto_fill', allowedPurposes: ['matching', 'application'],
      });
      updated.push(key);
    }
    return reply.header('cache-control', 'no-store').send({ saved: true, updated, employmentCount: body.data.employment.length, educationCount: body.data.education.length });
  });

  const leavingReasonLinkSchema = z.object({
    sourceRevision: z.string().min(3).max(200),
    links: z
      .array(z.object({ rowIndex: z.number().int().min(0).max(49), reasonKey: z.string().min(1).max(200) }))
      .max(50),
    confirmed: z.literal(true),
  });

  /**
   * Reads the employment rows and the recorded reasons for leaving, in the shape the link screen
   * needs. `sourceRevision` binds a later confirmation to exactly what was shown here.
   */
  async function leavingReasonState(service: ProfileService, userId: string) {
    const facts = await service.listFacts(userId);
    const historyFact = facts.find((fact) => fact.key === 'employment.history');
    if (historyFact?.status !== 'verified' || !Array.isArray(historyFact.value)) return null;
    const rowShape = z.object({
      employer: z.string().min(1),
      title: z.string().min(1),
      startDate: z.string().min(1).nullish(),
      endDate: z.string().min(1).nullish(),
    });
    const history: EmploymentRowRef[] = [];
    historyFact.value.forEach((raw, rowIndex) => {
      const parsed = rowShape.safeParse(raw);
      if (!parsed.success) return;
      history.push({
        rowIndex,
        employer: parsed.data.employer,
        title: parsed.data.title,
        startDate: parsed.data.startDate ?? null,
        endDate: parsed.data.endDate ?? null,
      });
    });
    const reasonShape = z.object({
      employer: z.string().min(1),
      reasonForLeaving: z.string().min(1),
      contractType: z.string().min(1).optional(),
    });
    const reasons: LeavingReasonRecord[] = [];
    const reasonVersions: string[] = [];
    for (const fact of facts) {
      if (!fact.key.startsWith('employment.leaving_reasons.')) continue;
      const parsed = reasonShape.safeParse(fact.value);
      if (!parsed.success) continue;
      reasons.push({ key: fact.key, ...parsed.data });
      reasonVersions.push(`${fact.key}:${String(fact.version)}`);
    }
    // Hashed rather than concatenated. The composed string grows with every recorded reason and
    // overran the field's length limit once four were stored, which rejected every confirmation as
    // invalid. A digest is bounded, and still changes whenever the history or any reason changes.
    const composed = `${historyFact.id}:${String(historyFact.version)}:${reasonVersions.sort().join(',')}`;
    return {
      history,
      reasons,
      sourceRevision: createHash('sha256').update(composed).digest('hex'),
    };
  }

  app.get<{ Params: { userId: string } }>('/v1/profile/:userId/leaving-reasons', async (request, reply) => {
    const userId = z.uuid().safeParse(request.params.userId);
    if (!userId.success) return reply.code(400).send({ error: 'invalid_user_id' });
    const state = await leavingReasonState(options.profileService, userId.data);
    if (state === null) {
      return reply.code(409).send({
        error: 'employment_history_missing',
        message: 'Confirm your employment history first.',
      });
    }
    const draft = draftLeavingReasonLinks(state.history, state.reasons);
    return reply.header('cache-control', 'no-store').send({
      ...draft,
      reasons: state.reasons,
      sourceRevision: state.sourceRevision,
    });
  });

  /**
   * Records which reason belongs to which role.
   *
   * The reason wording is never altered: only the employer it is filed against changes, to the exact
   * string the employment row carries, so the resolver's exact join succeeds afterwards. What the
   * person originally typed is preserved on the fact, and the previous version survives anyway
   * because facts are versioned.
   */
  app.post<{ Params: { userId: string } }>('/v1/profile/:userId/leaving-reasons', async (request, reply) => {
    const userId = z.uuid().safeParse(request.params.userId);
    const body = leavingReasonLinkSchema.safeParse(request.body);
    if (!userId.success || !body.success) return reply.code(400).send({ error: 'invalid_request' });
    const state = await leavingReasonState(options.profileService, userId.data);
    if (state === null) return reply.code(409).send({ error: 'employment_history_missing' });
    if (state.sourceRevision !== body.data.sourceRevision) {
      return reply.code(409).send({
        error: 'profile_changed',
        message: 'Your history or reasons changed. Reload and check the links again.',
      });
    }
    const outcome = applyLeavingReasonLinks(state.history, state.reasons, body.data.links);
    if (!outcome.ok) return reply.code(400).send({ error: outcome.error });
    for (const update of outcome.updates) {
      await options.profileService.addConfirmedUserFact({
        userId: userId.data,
        key: update.key,
        value: update.value,
        confirmed: true,
        sensitivity: 'personal',
        usePolicy: 'auto_fill',
        allowedPurposes: ['matching', 'application'],
      });
    }
    return reply.header('cache-control', 'no-store').send({
      saved: true,
      updated: outcome.updates.length,
      linked: body.data.links.length,
    });
  });

  app.get<{ Params: { userId: string } }>('/v1/profile/:userId/answer-vault', async (request, reply) => {
    const userId = z.uuid().safeParse(request.params.userId);
    if (!userId.success) return reply.code(400).send({ error: 'invalid_user_id' });
    const facts = await options.profileService.listFacts(userId.data);
    const entries = answerTopics.flatMap((topic) => {
      const fact = facts.find((candidate) => candidate.key === answerTopicFactKey(topic));
      const value = storedAnswerSchema.safeParse(fact?.value);
      return value.success && value.data.topic === topic
        ? [{ topic, answer: value.data.answer, sensitive: answerTopicIsSensitive(topic), version: fact?.version }]
        : [];
    });
    return reply.header('cache-control', 'no-store').send({ entries });
  });

  app.put<{ Params: { userId: string; topic: string } }>(
    '/v1/profile/:userId/answer-vault/:topic', async (request, reply) => {
      const userId = z.uuid().safeParse(request.params.userId);
      const topic = answerTopicSchema.safeParse(request.params.topic);
      const body = z.object({ answer: z.string().trim().min(1).max(3000), confirmed: z.literal(true) }).safeParse(request.body);
      if (!userId.success || !topic.success || !body.success) return reply.code(400).send({ error: 'invalid_request' });
      const key = answerTopicFactKey(topic.data);
      const value = { topic: topic.data, answer: body.data.answer };
      const current = (await options.profileService.listFacts(userId.data)).find((fact) => fact.key === key);
      if (JSON.stringify(current?.value) === JSON.stringify(value)) {
        return reply.header('cache-control', 'no-store').send({ saved: true, changed: false });
      }
      await options.profileService.addConfirmedUserFact({
        userId: userId.data, key, value, confirmed: true,
        sensitivity: answerTopicIsSensitive(topic.data) ? 'high_risk' : 'personal',
        // The vault is not an automatic answer source yet. A later adapter needs exact-question
        // matching, an allowed site and a separate use policy before it may fill anything.
        usePolicy: 'never_auto_fill', allowedPurposes: ['application'],
      });
      return reply.header('cache-control', 'no-store').send({ saved: true, changed: true });
    },
  );

  app.delete<{ Params: { userId: string; topic: string } }>(
    '/v1/profile/:userId/answer-vault/:topic', async (request, reply) => {
      const userId = z.uuid().safeParse(request.params.userId);
      const topic = answerTopicSchema.safeParse(request.params.topic);
      if (!userId.success || !topic.success) return reply.code(400).send({ error: 'invalid_request' });
      await options.profileService.deleteUserFact(userId.data, answerTopicFactKey(topic.data));
      return reply.header('cache-control', 'no-store').send({ removed: true });
    },
  );

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
