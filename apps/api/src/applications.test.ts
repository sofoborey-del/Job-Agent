import { randomBytes } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { fakeAtsAdapter } from '@job-agent/adapters';
import { ApplicationWorkflowService, type ApplicationStores } from '@job-agent/application';
import type { FieldInventory } from '@job-agent/browser-core';
import {
  createApplicationStores,
  createMigratedTestDatabase,
  createTrackingStores,
  SqlSitePolicyStore,
  type PGliteDatabase,
} from '@job-agent/db';
import type { KnowledgeFact } from '@job-agent/domain';
import {
  InMemoryArtifactStore,
  InMemoryDocumentRepository,
  InMemoryProfileRepository,
  CvProcessingService,
  DocumentService,
  ProfileService,
} from '@job-agent/profile';
import { FieldCipher, StaticEncryptionKeyProvider } from '@job-agent/security';
import type { TrackingStores } from '@job-agent/tracking';
import { v7 as uuidv7 } from 'uuid';

import type { ApplicationRunner, RunOutcome } from '@job-agent/orchestrator';

import type { ApprovedDocument } from './application-routes.js';
import { buildServer } from './server.js';

const adminToken = 'test-token-that-is-at-least-thirty-two-characters';
const ORIGIN = 'http://127.0.0.1:3311';
const adapter = fakeAtsAdapter(ORIGIN);
const auth = { authorization: `Bearer ${adminToken}` };

let app: ReturnType<typeof buildServer>;
let database: { db: PGliteDatabase; close: () => Promise<void> };
let applicationStores: ApplicationStores;
let trackingStores: TrackingStores;
let workflow: ApplicationWorkflowService;
let cipher: FieldCipher;
let userId: string;
let jobId: string;

/** Reads the one row a test expects without a non-null assertion. */
function only<T>(rows: readonly T[]): T {
  const [row] = rows;
  if (row === undefined) throw new Error('expected at least one row');
  return row;
}

function fact(key: string, value: unknown): KnowledgeFact<unknown> {
  return {
    id: uuidv7(),
    key,
    value,
    status: 'verified',
    source: 'user',
    sensitivity: 'normal',
    usePolicy: 'auto_fill',
    allowedPurposes: ['matching', 'application'],
    version: 1,
  };
}

/** Synthetic throughout: no real applicant value is used in these tests. */
const syntheticFacts: KnowledgeFact<unknown>[] = [
  fact('identity.first_name', 'Sam'),
  fact('identity.last_name', 'Tester'),
  fact('contact.email', 'sam.tester@example.test'),
];

/** The equal-opportunities step. Every field here is one only a person may answer. */
function sensitiveInventory(): FieldInventory {
  return {
    stepId: 'questions',
    url: `${ORIGIN}/apply/abc/questions`,
    pageFingerprint: 'e'.repeat(64),
    fields: [
      {
        fieldKey: 'disability',
        label: 'Do you consider yourself to have a disability?',
        controlType: 'radio',
        selector: '[name="disability"]',
        required: true,
        options: ['Yes', 'No', 'Prefer not to say'],
      },
    ],
    validationMessages: [],
    humanOnlyMarkers: [],
  };
}

function detailsInventory(): FieldInventory {
  return {
    stepId: 'details',
    url: `${ORIGIN}/apply/abc/details`,
    pageFingerprint: 'a'.repeat(64),
    fields: [
      {
        fieldKey: 'first_name',
        label: 'First name',
        controlType: 'text',
        selector: '[name="first_name"]',
        required: true,
        options: [],
      },
      {
        fieldKey: 'last_name',
        label: 'Last name',
        controlType: 'text',
        selector: '[name="last_name"]',
        required: true,
        options: [],
      },
      {
        fieldKey: 'email',
        label: 'Email address',
        controlType: 'email',
        selector: '[name="email"]',
        required: true,
        options: [],
      },
      {
        fieldKey: 'favourite_colour',
        label: 'Which colour best describes your working style?',
        controlType: 'text',
        selector: '[name="favourite_colour"]',
        required: false,
        options: [],
      },
    ],
    validationMessages: [],
    humanOnlyMarkers: [],
  };
}

async function seedJob(): Promise<string> {
  const companyId = uuidv7();
  const id = uuidv7();
  await database.db.query(
    `INSERT INTO companies (id, canonical_name) VALUES ($1, 'Example Council')`,
    [companyId],
  );
  await database.db.query(
    `INSERT INTO jobs (
       id, company_id, canonical_url, title, description, location_json, content_hash, fingerprint,
       version, status
     ) VALUES ($1, $2, $3, 'Information Governance Officer', 'Synthetic advert.',
       '{"text":"Glasgow"}'::jsonb, $4, $5, 1, 'open')`,
    [id, companyId, `https://myjobscotland.gov.uk/jobs/${id}`, 'c'.repeat(64), 'd'.repeat(64)],
  );
  await database.db.query(
    `INSERT INTO job_tracking (
       id, user_id, job_id, lifecycle_status, review_status, decided_by, score, salary_gate,
       needs_rematch
     ) VALUES ($1, $2, $3, 'open', 'shortlisted', 'system', 72, 'pass', false)`,
    [uuidv7(), userId, id],
  );
  return id;
}

/** Starts an attempt and plans the first step, which leaves one unknown-field question open. */
async function startPausedApplication(): Promise<{ applicationId: string; attemptId: string }> {
  const started = await workflow.startAttempt({
    userId,
    jobId,
    matchRunId: null,
    policyVersion: 'test-policy',
    targetOrigin: ORIGIN,
  });
  await applicationStores.applications.transition({
    applicationId: started.application.id,
    to: 'FILLING',
    actor: 'system',
    reason: 'test',
    correlationId: uuidv7(),
    now: new Date(),
  });
  await workflow.planStep({
    attemptId: started.attempt.id,
    inventory: detailsInventory(),
    facts: syntheticFacts,
    approvedDocument: null,
  });
  return { applicationId: started.application.id, attemptId: started.attempt.id };
}

describe('real application preparation and external submission records', () => {
  it('records user-reported submission idempotently and blocks new attempts', async () => {
    const payload = {
      jobId,
      providerReference: 'EXAMPLE-123',
      submittedAt: '2026-09-01T08:35:00+01:00',
      confirmed: true,
    };
    for (let i = 0; i < 2; i++) {
      const response = await app.inject({
        method: 'POST',
        url: `/v1/applications/${userId}/external-submission`,
        headers: auth,
        payload,
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        status: 'submitted',
        duplicateApplicationBlocked: true,
      });
    }
    const packet = await app.inject({
      method: 'GET',
      url: `/v1/applications/${userId}/preparation/${jobId}`,
      headers: auth,
    });
    expect(packet.json()).toMatchObject({
      status: 'submitted',
      facts: [],
      autoSubmitEnabled: false,
    });
    await expect(
      workflow.startAttempt({
        userId,
        jobId,
        matchRunId: null,
        policyVersion: 'test',
        targetOrigin: ORIGIN,
      }),
    ).rejects.toThrow('already been submitted');
    expect((await database.db.query('SELECT * FROM external_submissions')).rows).toHaveLength(1);
    expect(await applicationStores.applications.findByJob(userId, jobId)).toBeNull();
  });
  it('requires authentication, confirmation and an owned tracked job', async () => {
    const payload = {
      jobId,
      providerReference: 'EXAMPLE',
      submittedAt: '2026-09-01T08:35:00Z',
      confirmed: true,
    };
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/v1/applications/${userId}/external-submission`,
          payload,
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/v1/applications/${userId}/external-submission`,
          headers: auth,
          payload: { ...payload, confirmed: false },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/v1/applications/${uuidv7()}/external-submission`,
          headers: auth,
          payload,
        })
      ).statusCode,
    ).toBe(404);
  });
  it('prepares without creating attempts or enabling real browser actions', async () => {
    const packet = await app.inject({
      method: 'GET',
      url: `/v1/applications/${userId}/preparation/${jobId}`,
      headers: auth,
    });
    expect(packet.statusCode).toBe(200);
    expect(packet.json()).toMatchObject({
      status: 'manual_preparation',
      browserPrefillEnabled: false,
      autoSubmitEnabled: false,
    });
    expect(await applicationStores.applications.findByJob(userId, jobId)).toBeNull();
  });
});

beforeEach(async () => {
  database = await createMigratedTestDatabase();
  userId = uuidv7();
  await database.db.query(
    `INSERT INTO users (id, timezone, status) VALUES ($1, 'Europe/London', 'active')`,
    [userId],
  );
  jobId = await seedJob();

  cipher = new FieldCipher(
    new StaticEncryptionKeyProvider('test-v1', new Map([['test-v1', randomBytes(32)]])),
  );
  applicationStores = createApplicationStores(database.db);
  trackingStores = createTrackingStores(database.db);
  workflow = new ApplicationWorkflowService({ stores: applicationStores, cipher, adapter });

  const documentRepository = new InMemoryDocumentRepository();
  const artifactStore = new InMemoryArtifactStore();
  app = buildServer({
    profileService: new ProfileService(new InMemoryProfileRepository(), cipher),
    documentService: new DocumentService(documentRepository, artifactStore, cipher),
    cvProcessingService: new CvProcessingService(documentRepository, artifactStore, cipher, {
      scan: () => Promise.resolve(),
    }),
    adminToken,
    tracking: {
      stores: trackingStores,
      sitePolicyFor: (domain) => new SqlSitePolicyStore(database.db).findByDomain(domain),
      listSitePolicies: () => new SqlSitePolicyStore(database.db).list(),
      notificationsConfigured: false,
      manualSourceKey: 'myjobscotland_manual',
      schedulerEnabled: false,
    },
    applications: {
      stores: applicationStores,
      tracking: trackingStores,
      workflow,
      adapter,
      cipher,
      fakeAtsOrigin: ORIGIN,
    },
  });
});

afterEach(async () => {
  await app.close();
  await database.close();
});

describe('the local application screens', () => {
  it('serves the page without a token and says clearly that no employer is involved', async () => {
    const page = await app.inject({ method: 'GET', url: '/applications' });
    expect(page.statusCode).toBe(200);
    expect(page.headers['cache-control']).toBe('no-store');
    expect(page.body).toContain('practice');
    expect(page.body.toLowerCase()).toContain('fake');
  });

  it('reports fake-ATS-only browser automation on the health check', async () => {
    const health = await app.inject({ method: 'GET', url: '/health' });
    expect(health.json()).toMatchObject({
      browserAutomation: 'fake_ats_only',
      productionApplicationAutomation: false,
      autoSubmit: false,
    });
  });

  it('requires the admin token for application data', async () => {
    const response = await app.inject({ method: 'GET', url: `/v1/applications/${userId}` });
    expect(response.statusCode).toBe(401);
  });
});

describe('the application API', () => {
  it('lists an application with its open question count', async () => {
    const ids = await startPausedApplication();
    const response = await app.inject({
      method: 'GET',
      url: `/v1/applications/${userId}`,
      headers: auth,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json<{
      realEmployerAutomation: boolean;
      applications: { applicationId: string; jobTitle: string; openQuestions: number }[];
    }>();
    expect(body.realEmployerAutomation).toBe(false);
    expect(only(body.applications)).toMatchObject({
      applicationId: ids.applicationId,
      jobTitle: 'Information Governance Officer',
    });
    expect(only(body.applications).openQuestions).toBeGreaterThan(0);
  });

  it('shows why each answer was used and never returns a sensitive value', async () => {
    const ids = await startPausedApplication();
    const response = await app.inject({
      method: 'GET',
      url: `/v1/applications/${userId}/${ids.applicationId}`,
      headers: auth,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json<{
      fields: {
        fieldKey: string;
        evidenceFactIds: string[];
        unknown: boolean;
        sensitive: boolean;
        answerPreview: string | null;
      }[];
      questions: { fieldKey: string; reason: string }[];
      steps: { id: string; humanOnly: boolean }[];
    }>();
    const firstName = body.fields.find((field) => field.fieldKey === 'first_name');
    expect(firstName?.evidenceFactIds).toHaveLength(1);
    expect(body.questions.some((question) => question.fieldKey === 'favourite_colour')).toBe(true);
    expect(body.steps.some((step) => step.humanOnly)).toBe(true);
    for (const field of body.fields) {
      if (field.sensitive) expect(field.answerPreview).toBeNull();
    }
  });

  it('refuses an application belonging to another user', async () => {
    const ids = await startPausedApplication();
    const response = await app.inject({
      method: 'GET',
      url: `/v1/applications/${uuidv7()}/${ids.applicationId}`,
      headers: auth,
    });
    expect(response.statusCode).toBe(404);
  });

  it('records an answer once and treats an identical resend as already recorded', async () => {
    const ids = await startPausedApplication();
    const question = only(await applicationStores.questions.listOpen(ids.applicationId));
    const url = `/v1/applications/${userId}/${ids.applicationId}/questions/${question.id}/answer`;

    const first = await app.inject({
      method: 'POST',
      url,
      headers: auth,
      payload: { value: 'Blue' },
    });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ applied: true });

    const replay = await app.inject({
      method: 'POST',
      url,
      headers: auth,
      payload: { value: 'Blue' },
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toMatchObject({ applied: false });
    expect(replay.json<{ message: string }>().message).toContain('Nothing was repeated');
  });

  it('never echoes the answer back', async () => {
    const ids = await startPausedApplication();
    const question = only(await applicationStores.questions.listOpen(ids.applicationId));
    const response = await app.inject({
      method: 'POST',
      url: `/v1/applications/${userId}/${ids.applicationId}/questions/${question.id}/answer`,
      headers: auth,
      payload: { value: 'a-very-distinctive-synthetic-answer' },
    });
    expect(response.body).not.toContain('a-very-distinctive-synthetic-answer');
  });

  it('refuses to approve against a review manifest that is no longer current', async () => {
    const ids = await startPausedApplication();
    const review = await app.inject({
      method: 'POST',
      url: `/v1/applications/${userId}/${ids.applicationId}/review`,
      headers: auth,
      payload: { jobId, jobVersion: 1 },
    });
    expect(review.statusCode).toBe(200);
    const { manifestHash } = review.json<{ manifestHash: string }>();

    const stale = await app.inject({
      method: 'POST',
      url: `/v1/applications/${userId}/${ids.applicationId}/decision`,
      headers: auth,
      payload: { decision: 'approved', manifestHash: 'f'.repeat(64) },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ error: 'stale_manifest' });
    expect(manifestHash).not.toBe('f'.repeat(64));
  });

  /**
   * A sensitive step opens `human_action` questions, which the answer route refuses by design.
   * Without the confirmation route below there is no way to close them from the screens, and the
   * run can never be resumed. This covers the route surface, not just the workflow.
   */
  it('lets the user confirm a human-only step from the screens, and then resume', async () => {
    const ids = await startPausedApplication();
    await workflow.planStep({
      attemptId: ids.attemptId,
      inventory: sensitiveInventory(),
      facts: syntheticFacts,
      approvedDocument: null,
    });
    const sensitive = (await applicationStores.questions.listOpen(ids.applicationId)).filter(
      (question) => question.responseKind === 'human_action',
    );
    expect(sensitive.length).toBeGreaterThan(0);

    // The answer route must keep refusing these.
    const refusedAnswer = await app.inject({
      method: 'POST',
      url: `/v1/applications/${userId}/${ids.applicationId}/questions/${only(sensitive).id}/answer`,
      headers: auth,
      payload: { value: 'Yes' },
    });
    expect(refusedAnswer.statusCode).toBe(409);

    // Confirming before taking over is refused, so the sequence stays honest.
    const tooEarly = await app.inject({
      method: 'POST',
      url: `/v1/applications/${userId}/${ids.applicationId}/questions/${only(sensitive).id}/completed`,
      headers: auth,
      payload: {},
    });
    expect(tooEarly.statusCode).toBe(409);
    expect(tooEarly.json()).toMatchObject({ error: 'takeover_not_active' });

    await app.inject({
      method: 'POST',
      url: `/v1/applications/${userId}/${ids.applicationId}/takeover`,
      headers: auth,
    });
    for (const question of await applicationStores.questions.listOpen(ids.applicationId)) {
      if (question.responseKind !== 'human_action') {
        await app.inject({
          method: 'POST',
          url: `/v1/applications/${userId}/${ids.applicationId}/questions/${question.id}/answer`,
          headers: auth,
          payload: { value: 'Blue' },
        });
        continue;
      }
      const done = await app.inject({
        method: 'POST',
        url: `/v1/applications/${userId}/${ids.applicationId}/questions/${question.id}/completed`,
        headers: auth,
        payload: {},
      });
      expect(done.statusCode).toBe(200);
      expect(done.json()).toMatchObject({ completed: true });
    }

    const resumed = await app.inject({
      method: 'POST',
      url: `/v1/applications/${userId}/${ids.applicationId}/resume`,
      headers: auth,
    });
    expect(resumed.json()).toMatchObject({ resumed: true });
  });

  it('never returns what the user entered on a human-only step', async () => {
    const ids = await startPausedApplication();
    await workflow.planStep({
      attemptId: ids.attemptId,
      inventory: sensitiveInventory(),
      facts: syntheticFacts,
      approvedDocument: null,
    });
    await app.inject({
      method: 'POST',
      url: `/v1/applications/${userId}/${ids.applicationId}/takeover`,
      headers: auth,
    });
    const question = only(
      (await applicationStores.questions.listOpen(ids.applicationId)).filter(
        (candidate) => candidate.responseKind === 'human_action',
      ),
    );
    await app.inject({
      method: 'POST',
      url: `/v1/applications/${userId}/${ids.applicationId}/questions/${question.id}/completed`,
      headers: auth,
      payload: {},
    });
    const detail = await app.inject({
      method: 'GET',
      url: `/v1/applications/${userId}/${ids.applicationId}`,
      headers: auth,
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.body).not.toContain('entered by the user');
    const body = detail.json<{
      fields: Array<{ fieldKey: string; answerPreview: string | null }>;
    }>();
    const field = body.fields.find((candidate) => candidate.fieldKey === question.fieldKey);
    if (field !== undefined) expect(field.answerPreview).toBeNull();
  });

  it('records manual takeover and refuses to resume while a question is open', async () => {
    const ids = await startPausedApplication();
    const takeover = await app.inject({
      method: 'POST',
      url: `/v1/applications/${userId}/${ids.applicationId}/takeover`,
      headers: auth,
    });
    expect(takeover.json()).toMatchObject({ takeoverRequested: true });

    const blocked = await app.inject({
      method: 'POST',
      url: `/v1/applications/${userId}/${ids.applicationId}/resume`,
      headers: auth,
    });
    expect(blocked.json()).toMatchObject({ resumed: false });

    const question = only(await applicationStores.questions.listOpen(ids.applicationId));
    await app.inject({
      method: 'POST',
      url: `/v1/applications/${userId}/${ids.applicationId}/questions/${question.id}/answer`,
      headers: auth,
      payload: { value: 'Blue' },
    });
    const resumed = await app.inject({
      method: 'POST',
      url: `/v1/applications/${userId}/${ids.applicationId}/resume`,
      headers: auth,
    });
    expect(resumed.json()).toMatchObject({ resumed: true });
  });

  it('delivers the same job twice without creating a second application', async () => {
    const first = await startPausedApplication();
    const second = await workflow.startAttempt({
      userId,
      jobId,
      matchRunId: null,
      policyVersion: 'test-policy',
      targetOrigin: ORIGIN,
    });
    expect(second.application.id).toBe(first.applicationId);

    const response = await app.inject({
      method: 'GET',
      url: `/v1/applications/${userId}`,
      headers: auth,
    });
    expect(response.json<{ applications: unknown[] }>().applications).toHaveLength(1);
  });
});

describe('starting and advancing a practice application', () => {
  type Captured = Parameters<ApplicationRunner['runUntilPause']>[0];

  let captured: Captured[];

  /** A runner that records what it was asked to do. No browser is started in these tests. */
  function stubRunner(): ApplicationRunner {
    return {
      runUntilPause: (input: Captured) => {
        captured.push(input);
        const outcome: RunOutcome = {
          finishedStepIds: ['details'],
          pausedAt: 'details',
          pauseReason: 'unknown_field',
          refusal: null,
          reachedReview: false,
        };
        return Promise.resolve(outcome);
      },
    } as unknown as ApplicationRunner;
  }

  function buildDriven(options?: {
    origin?: string;
    approvedDocument?: ApprovedDocument | null;
  }): ReturnType<typeof buildServer> {
    const documentRepository = new InMemoryDocumentRepository();
    const artifactStore = new InMemoryArtifactStore();
    return buildServer({
      profileService: new ProfileService(new InMemoryProfileRepository(), cipher),
      documentService: new DocumentService(documentRepository, artifactStore, cipher),
      cvProcessingService: new CvProcessingService(documentRepository, artifactStore, cipher, {
        scan: () => Promise.resolve(),
      }),
      adminToken,
      tracking: {
        stores: trackingStores,
        sitePolicyFor: (domain) => new SqlSitePolicyStore(database.db).findByDomain(domain),
        listSitePolicies: () => new SqlSitePolicyStore(database.db).list(),
        notificationsConfigured: false,
        manualSourceKey: 'myjobscotland_manual',
        schedulerEnabled: false,
      },
      applications: {
        stores: applicationStores,
        tracking: trackingStores,
        workflow,
        adapter,
        cipher,
        fakeAtsOrigin: options?.origin ?? ORIGIN,
        drive: {
          runner: stubRunner(),
          loadFacts: () => Promise.resolve(syntheticFacts),
          loadApprovedDocument: () => Promise.resolve(options?.approvedDocument ?? null),
          policyVersion: 'test-drive-policy',
        },
      },
    });
  }

  /** Gives the attempt a session so the route does not call out to the fake ATS. */
  async function withSession(applicationId: string): Promise<void> {
    const attempt = await applicationStores.attempts.current(applicationId);
    if (attempt === null) throw new Error('expected an attempt');
    await applicationStores.attempts.setSessionRef(attempt.id, 'seeded-session', new Date());
  }

  /** Closes whatever the planning step opened, so a run is allowed to proceed. */
  async function clearQuestions(applicationId: string): Promise<void> {
    const attempt = await applicationStores.attempts.current(applicationId);
    if (attempt === null) throw new Error('expected an attempt');
    await applicationStores.questions.supersedeOpen(attempt.id, new Date());
  }

  beforeEach(() => {
    captured = [];
  });

  it('refuses to start when the build cannot drive a browser', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/v1/applications/${userId}/start`,
      headers: auth,
      payload: { jobId },
    });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ error: 'driving_unavailable' });
  });

  it('requires the admin token', async () => {
    const driven = buildDriven();
    const response = await driven.inject({
      method: 'POST',
      url: `/v1/applications/${userId}/start`,
      payload: { jobId },
    });
    expect(response.statusCode).toBe(401);
    await driven.close();
  });

  it('refuses a job that is not on the tracker for this user', async () => {
    const driven = buildDriven();
    const response = await driven.inject({
      method: 'POST',
      url: `/v1/applications/${userId}/start`,
      headers: auth,
      payload: { jobId: uuidv7() },
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: 'unknown_job' });
    expect(captured).toHaveLength(0);
    await driven.close();
  });

  it('never tells the runner it may submit', async () => {
    const { applicationId } = await startPausedApplication();
    await withSession(applicationId);
    await clearQuestions(applicationId);

    const driven = buildDriven();
    const response = await driven.inject({
      method: 'POST',
      url: `/v1/applications/${userId}/start`,
      headers: auth,
      payload: { jobId },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      autoSubmitEnabled: false,
      realEmployerAutomation: false,
      pauseReason: 'unknown_field',
    });
    expect(only(captured).sitePolicy).toEqual({
      origin: ORIGIN,
      applyMode: 'manual_only',
      submitPermitted: false,
    });
    expect(only(captured).startUrl).toBe(`${ORIGIN}/apply/seeded-session/details`);
    await driven.close();
  });

  it('will not run while a question is waiting for the user', async () => {
    const { applicationId } = await startPausedApplication();
    await withSession(applicationId);
    const driven = buildDriven();
    const response = await driven.inject({
      method: 'POST',
      url: `/v1/applications/${userId}/${applicationId}/advance`,
      headers: auth,
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: 'questions_open' });
    expect(captured).toHaveLength(0);
    await driven.close();
  });

  it('creates no second application when start is repeated', async () => {
    const { applicationId } = await startPausedApplication();
    await withSession(applicationId);
    await clearQuestions(applicationId);

    const driven = buildDriven();
    for (let round = 0; round < 2; round += 1) {
      const response = await driven.inject({
        method: 'POST',
        url: `/v1/applications/${userId}/start`,
        headers: auth,
        payload: { jobId },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ applicationId });
    }
    expect(await applicationStores.applications.list(userId, 25)).toHaveLength(1);
    const current = await applicationStores.attempts.current(applicationId);
    expect(current?.attemptNo).toBe(1);
    await driven.close();
  });

  it('reuses the session it already opened rather than starting another', async () => {
    const { applicationId } = await startPausedApplication();
    await withSession(applicationId);
    await clearQuestions(applicationId);
    const driven = buildDriven();
    for (let round = 0; round < 2; round += 1) {
      await driven.inject({
        method: 'POST',
        url: `/v1/applications/${userId}/${applicationId}/advance`,
        headers: auth,
      });
    }
    expect(captured.map((input) => input.startUrl)).toEqual([
      `${ORIGIN}/apply/seeded-session/details`,
      `${ORIGIN}/apply/seeded-session/details`,
    ]);
    await driven.close();
  });

  it('says so plainly when the practice job site is not running', async () => {
    const driven = buildDriven({ origin: 'http://127.0.0.1:3399' });
    const response = await driven.inject({
      method: 'POST',
      url: `/v1/applications/${userId}/start`,
      headers: auth,
      payload: { jobId },
    });
    expect(response.statusCode).toBe(502);
    expect(response.json()).toMatchObject({ error: 'fake_ats_unavailable' });
    expect(captured).toHaveLength(0);
    await driven.close();
  });

  it('will not advance an application belonging to someone else', async () => {
    const { applicationId } = await startPausedApplication();
    const driven = buildDriven();
    const response = await driven.inject({
      method: 'POST',
      url: `/v1/applications/${uuidv7()}/${applicationId}/advance`,
      headers: auth,
    });
    expect(response.statusCode).toBe(404);
    expect(captured).toHaveLength(0);
    await driven.close();
  });

  it('hands the runner the approved CV and the verified facts, and returns neither', async () => {
    const { applicationId } = await startPausedApplication();
    await withSession(applicationId);
    await clearQuestions(applicationId);
    const approved: ApprovedDocument = {
      documentId: uuidv7(),
      sha256: 'f'.repeat(64),
      filename: 'cv.pdf',
      contentBase64: Buffer.from('%PDF-1.4 synthetic').toString('base64'),
    };
    const driven = buildDriven({ approvedDocument: approved });
    const response = await driven.inject({
      method: 'POST',
      url: `/v1/applications/${userId}/${applicationId}/advance`,
      headers: auth,
    });
    expect(response.statusCode).toBe(200);
    expect(only(captured).approvedDocument).toEqual(approved);
    expect(only(captured).facts).toHaveLength(syntheticFacts.length);
    // The response is a progress report, not a data export.
    expect(response.body).not.toContain(approved.contentBase64);
    expect(response.body).not.toContain('sam.tester@example.test');
    await driven.close();
  });
});
