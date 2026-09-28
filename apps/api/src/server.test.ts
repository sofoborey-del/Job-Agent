import { randomBytes } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DiscoveredJob } from '@job-agent/discovery';
import {
  CvProcessingService,
  DocumentService,
  InMemoryArtifactStore,
  InMemoryDocumentRepository,
  InMemoryProfileRepository,
  ProfileService,
} from '@job-agent/profile';
import { FieldCipher, StaticEncryptionKeyProvider } from '@job-agent/security';
import { resolveFact } from '@job-agent/knowledge-base';

import { buildServer } from './server.js';

const adminToken = 'test-token-that-is-at-least-thirty-two-characters';
let app: ReturnType<typeof buildServer>;
let profileService: ProfileService;

const discoveredJob: DiscoveredJob = {
  source: 'myjobscotland',
  externalId: '489999',
  canonicalUrl: 'https://myjobscotland.gov.uk/councils/example/jobs/customer-adviser-489999',
  title: 'Customer Adviser',
  employer: 'Example Council',
  location: 'Glasgow',
  description: 'Applicants must have customer service experience.',
  salary: {
    minimumMinor: 2_800_000,
    maximumMinor: 3_100_000,
    currency: 'GBP',
    basis: 'annual_base',
    confidence: 0.99,
    sourceText: '£28,000 - £31,000',
  },
  employmentTypes: ['FULL_TIME'],
  contractType: 'Permanent',
  hours: '35 hours',
  workPattern: 'Hybrid',
  publishedAt: '2026-09-20T09:00:00Z',
  closesAt: '2026-10-20T23:59:59Z',
  contentHash: 'a'.repeat(64),
};

beforeEach(() => {
  const cipher = new FieldCipher(
    new StaticEncryptionKeyProvider('test-v1', new Map([['test-v1', randomBytes(32)]])),
  );
  profileService = new ProfileService(new InMemoryProfileRepository(), cipher);
  const documentRepository = new InMemoryDocumentRepository();
  const artifactStore = new InMemoryArtifactStore();
  const documentService = new DocumentService(documentRepository, artifactStore, cipher);
  const cvProcessingService = new CvProcessingService(documentRepository, artifactStore, cipher, {
    scan: () => Promise.resolve(),
  });
  app = buildServer({
    profileService,
    documentService,
    cvProcessingService,
    adminToken,
    myJobScotlandFetcher: () => Promise.resolve(discoveredJob),
  });
});

afterEach(async () => {
  await app.close();
});

describe('local onboarding API', () => {
  it('provides a non-sensitive health endpoint and requires authentication elsewhere', async () => {
    expect((await app.inject({ method: 'GET', url: '/health' })).json()).toEqual({
      status: 'ok',
      browserAutomation: false,
      productionApplicationAutomation: false,
      autoSubmit: false,
    });
    expect(
      (await app.inject({ method: 'GET', url: '/v1/onboarding/requirements' })).statusCode,
    ).toBe(401);
  });

  it('serves a no-store local onboarding page without embedding secrets', async () => {
    const response = await app.inject({ method: 'GET', url: '/onboarding' });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['content-security-policy']).toContain("default-src 'self'");
    expect(response.body).toContain('Build your applicant profile');
    expect(response.body).not.toContain(adminToken);
    expect(response.body).not.toContain('localStorage');
  });

  it('serves a no-store CV review page without embedding secrets', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/cv-review?profileId=0199-0000-7000-8000-000000000000',
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body).toContain('Review your CV extraction');
    expect(response.body).not.toContain(adminToken);
    expect(response.body).not.toContain('localStorage');
  });

  describe('linking reasons for leaving to roles', () => {
    /** Invented throughout. Mirrors the real shape: CV rows carry a town the reason does not. */
    async function seedProfile(): Promise<{ userId: string; headers: Record<string, string> }> {
      const user = await profileService.createUser();
      const headers = { authorization: `Bearer ${adminToken}` };
      await profileService.addConfirmedUserFact({
        userId: user.userId,
        key: 'employment.history',
        value: [
          {
            employer: 'First Invented Ltd Glasgow Remote',
            title: 'Adviser',
            startDate: 'March 2021',
            endDate: 'August 2022',
          },
          {
            employer: 'Second Invented Plc',
            title: 'Assistant',
            startDate: 'January 2020',
            endDate: 'February 2021',
          },
          {
            employer: 'Third Invented Ltd',
            title: 'Clerk',
            startDate: 'June 2018',
            endDate: 'December 2019',
          },
        ],
        confirmed: true,
        sensitivity: 'normal',
        usePolicy: 'auto_fill',
        allowedPurposes: ['matching', 'application'],
      });
      for (const [key, employer] of [
        ['employment.leaving_reasons.first', 'First Invented Ltd'],
        ['employment.leaving_reasons.second', 'Second Invented Plc'],
      ] as const) {
        await profileService.addConfirmedUserFact({
          userId: user.userId,
          key,
          value: { employer, reasonForLeaving: `Left ${employer} for an invented reason` },
          confirmed: true,
          sensitivity: 'personal',
          usePolicy: 'auto_fill',
          allowedPurposes: ['matching', 'application'],
        });
      }
      return { userId: user.userId, headers };
    }

    type Draft = {
      sourceRevision: string;
      rows: Array<{ rowIndex: number; linkedKey: string | null; suggestedKey: string | null }>;
      reasons: Array<{ key: string }>;
    };

    async function draftFor(userId: string, headers: Record<string, string>): Promise<Draft> {
      const response = await app.inject({
        method: 'GET',
        url: `/v1/profile/${userId}/leaving-reasons`,
        headers,
      });
      return response.json<Draft>();
    }

    it('requires the admin token', async () => {
      const { userId } = await seedProfile();
      const response = await app.inject({
        method: 'GET',
        url: `/v1/profile/${userId}/leaving-reasons`,
      });
      expect(response.statusCode).toBe(401);
    });

    it('refuses before an employment history exists', async () => {
      const user = await profileService.createUser();
      const response = await app.inject({
        method: 'GET',
        url: `/v1/profile/${user.userId}/leaving-reasons`,
        headers: { authorization: `Bearer ${adminToken}` },
      });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ error: 'employment_history_missing' });
    });

    it('reports what already joins, what it proposes, and what it will not guess', async () => {
      const { userId, headers } = await seedProfile();
      const draft = await draftFor(userId, headers);
      expect(draft.rows[0]?.suggestedKey).toBe('employment.leaving_reasons.first');
      expect(draft.rows[0]?.linkedKey).toBeNull();
      expect(draft.rows[1]?.linkedKey).toBe('employment.leaving_reasons.second');
      expect(draft.rows[2]?.suggestedKey).toBeNull();
      expect(draft.rows[2]?.linkedKey).toBeNull();
    });

    it('re-files a confirmed link for the resolver, keeping the wording and what was typed', async () => {
      const { userId, headers } = await seedProfile();
      const draft = await draftFor(userId, headers);
      const saved = await app.inject({
        method: 'POST',
        url: `/v1/profile/${userId}/leaving-reasons`,
        headers,
        payload: {
          sourceRevision: draft.sourceRevision,
          links: [{ rowIndex: 0, reasonKey: 'employment.leaving_reasons.first' }],
          confirmed: true,
        },
      });
      expect(saved.statusCode).toBe(200);
      expect(saved.json()).toMatchObject({ saved: true, updated: 1 });

      const facts = await profileService.listFacts(userId);
      const reason = facts.find((fact) => fact.key === 'employment.leaving_reasons.first');
      expect(reason?.value).toMatchObject({
        employer: 'First Invented Ltd Glasgow Remote',
        reasonForLeaving: 'Left First Invented Ltd for an invented reason',
        employerAsEntered: 'First Invented Ltd',
      });

      const after = await draftFor(userId, headers);
      expect(after.rows[0]?.linkedKey).toBe('employment.leaving_reasons.first');
    });

    it('refuses a confirmation written against a profile that has since changed', async () => {
      const { userId, headers } = await seedProfile();
      const draft = await draftFor(userId, headers);
      await profileService.addConfirmedUserFact({
        userId,
        key: 'employment.leaving_reasons.third',
        value: { employer: 'Third Invented Ltd', reasonForLeaving: 'Another invented reason' },
        confirmed: true,
        sensitivity: 'personal',
        usePolicy: 'auto_fill',
        allowedPurposes: ['matching', 'application'],
      });
      const response = await app.inject({
        method: 'POST',
        url: `/v1/profile/${userId}/leaving-reasons`,
        headers,
        payload: {
          sourceRevision: draft.sourceRevision,
          links: [{ rowIndex: 0, reasonKey: 'employment.leaving_reasons.first' }],
          confirmed: true,
        },
      });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ error: 'profile_changed' });
    });

    it('refuses one reason against two roles', async () => {
      const { userId, headers } = await seedProfile();
      const draft = await draftFor(userId, headers);
      const response = await app.inject({
        method: 'POST',
        url: `/v1/profile/${userId}/leaving-reasons`,
        headers,
        payload: {
          sourceRevision: draft.sourceRevision,
          links: [
            { rowIndex: 0, reasonKey: 'employment.leaving_reasons.first' },
            { rowIndex: 2, reasonKey: 'employment.leaving_reasons.first' },
          ],
          confirmed: true,
        },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ error: 'reason_linked_twice' });
    });

    it('will not act without the explicit confirmation flag', async () => {
      const { userId, headers } = await seedProfile();
      const draft = await draftFor(userId, headers);
      const response = await app.inject({
        method: 'POST',
        url: `/v1/profile/${userId}/leaving-reasons`,
        headers,
        payload: {
          sourceRevision: draft.sourceRevision,
          links: [{ rowIndex: 0, reasonKey: 'employment.leaving_reasons.first' }],
        },
      });
      expect(response.statusCode).toBe(400);
    });

    it('still saves once several reasons are recorded', async () => {
      // Regression: the change-detection token was built by concatenating every reason's key and
      // version. With four or more recorded it overran the field's length limit, so every
      // confirmation was rejected as invalid and the screen silently saved nothing. The earlier
      // tests seeded only two reasons and so never reached the limit.
      const { userId, headers } = await seedProfile();
      for (const [key, employer] of [
        ['employment.leaving_reasons.fourth_invented_organisation', 'Fourth Invented Organisation'],
        ['employment.leaving_reasons.fifth_invented_organisation', 'Fifth Invented Organisation'],
        ['employment.leaving_reasons.sixth_invented_organisation', 'Sixth Invented Organisation'],
        ['employment.leaving_reasons.seventh_invented_organisation', 'Seventh Invented Company'],
      ] as const) {
        await profileService.addConfirmedUserFact({
          userId,
          key,
          value: { employer, reasonForLeaving: `Left ${employer} for an invented reason` },
          confirmed: true,
          sensitivity: 'personal',
          usePolicy: 'auto_fill',
          allowedPurposes: ['matching', 'application'],
        });
      }
      const draft = await draftFor(userId, headers);
      expect(draft.reasons.length).toBe(6);
      expect(draft.sourceRevision.length).toBeLessThanOrEqual(200);

      const response = await app.inject({
        method: 'POST',
        url: `/v1/profile/${userId}/leaving-reasons`,
        headers,
        payload: {
          sourceRevision: draft.sourceRevision,
          links: [{ rowIndex: 0, reasonKey: 'employment.leaving_reasons.first' }],
          confirmed: true,
        },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ saved: true, updated: 1 });
      expect((await draftFor(userId, headers)).rows[0]?.linkedKey).toBe(
        'employment.leaving_reasons.first',
      );
    });

    it('serves a no-store page that says the agent will not check the link for you', async () => {
      const response = await app.inject({ method: 'GET', url: '/leaving-reasons' });
      expect(response.statusCode).toBe(200);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.body).toContain('Link your reasons for leaving');
      expect(response.body).toContain('will not check this for you');
      expect(response.body).not.toContain(adminToken);
    });
  });

  it('serves a no-store application preparation page that promises no filling', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/application-prep?profileId=0199-0000-7000-8000-000000000000&jobId=0199-0000-7000-8000-000000000001',
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['content-security-policy']).toContain("default-src 'self'");
    expect(response.body).toContain('Prepare one application');
    expect(response.body).toContain('cannot fill a real employer form');
    // Reusable and demographic answers must start unticked; nothing is checked by default.
    expect(response.body).not.toContain('checked=');
    expect(response.body).not.toContain('.checked = true');
    expect(response.body).not.toContain(adminToken);
    expect(response.body).not.toContain('localStorage');
  });

  it('drafts reviewed CV history and saves structured rows only after explicit confirmation', async () => {
    const user = await profileService.createUser();
    const headers = { authorization: `Bearer ${adminToken}` };
    for (const [key, value] of [
      ['employment.cv_reviewed_text', 'Adviser Jul 2025 – Jun 2026\nExample Firm Remote\n• Supported customers.'],
      ['education.cv_reviewed_text', 'Certificate — Example College | Completed May 2025'],
    ] as const) {
      await profileService.addConfirmedUserFact({
        userId: user.userId, key, value, confirmed: true, sensitivity: 'normal',
        usePolicy: 'auto_fill', allowedPurposes: ['matching', 'application'],
      });
    }
    const path = `/v1/profile/${user.userId}`;
    expect((await app.inject({ method: 'GET', url: `${path}/history-draft` })).statusCode).toBe(401);
    const draftResponse = await app.inject({ method: 'GET', url: `${path}/history-draft`, headers });
    expect(draftResponse.statusCode).toBe(200);
    expect(draftResponse.headers['cache-control']).toBe('no-store');
    const draft = draftResponse.json<{
      sourceRevision: string;
      employment: Array<{ employer: string; title: string; startDate: string | null; endDate: string | null; evidenceSummary: string | null }>;
      education: Array<{ institution: string; qualification: string; field: string | null; startDate: string | null; endDate: string | null; grade: string | null }>;
    }>();
    expect(draft.employment).toHaveLength(1);
    expect((await profileService.listFacts(user.userId)).find((fact) => fact.key === 'employment.history')).toBeUndefined();
    const payload = {
      sourceRevision: draft.sourceRevision,
      employment: draft.employment.map((entry) => ({ ...entry, employer: 'Example Firm' })),
      education: draft.education.map(({ institution, qualification, field, startDate, endDate, grade }) => ({ institution, qualification, field, startDate, endDate, grade })),
      confirmed: true,
    };
    expect((await app.inject({ method: 'POST', url: `${path}/history-confirm`, headers, payload: { ...payload, confirmed: false } })).statusCode).toBe(400);
    const saved = await app.inject({ method: 'POST', url: `${path}/history-confirm`, headers, payload });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toMatchObject({ saved: true, employmentCount: 1, educationCount: 1 });
    const facts = await profileService.listFacts(user.userId);
    expect(facts.find((fact) => fact.key === 'employment.history')?.value).toMatchObject([{ employer: 'Example Firm' }]);
    const replay = await app.inject({ method: 'POST', url: `${path}/history-confirm`, headers, payload });
    expect(replay.json<{ updated: string[] }>().updated).toEqual([]);
  });

  it('stores optional sensitive answers locally but never makes them automatic form answers', async () => {
    const user = await profileService.createUser();
    const headers = { authorization: `Bearer ${adminToken}` };
    const url = `/v1/profile/${user.userId}/answer-vault/sexual_orientation`;
    expect((await app.inject({ method: 'GET', url: `/v1/profile/${user.userId}/answer-vault` })).statusCode).toBe(401);
    expect((await app.inject({ method: 'PUT', url, headers, payload: { answer: 'Prefer not to say', confirmed: false } })).statusCode).toBe(400);
    const saved = await app.inject({ method: 'PUT', url, headers, payload: { answer: 'Prefer not to say', confirmed: true } });
    expect(saved.statusCode).toBe(200);
    expect(saved.body).not.toContain('Prefer not to say');
    const fact = (await profileService.listFacts(user.userId)).find((item) => item.key === 'application.answer_vault.sexual_orientation');
    expect(fact).toMatchObject({ sensitivity: 'high_risk', usePolicy: 'never_auto_fill', allowedPurposes: ['application'] });
    if (fact === undefined) throw new Error('Saved answer fact was not found');
    expect(resolveFact(fact, 'application').status).toBe('requires_user');
    const listed = await app.inject({ method: 'GET', url: `/v1/profile/${user.userId}/answer-vault`, headers });
    expect(listed.headers['cache-control']).toBe('no-store');
    expect(listed.json()).toMatchObject({ entries: [{ topic: 'sexual_orientation', answer: 'Prefer not to say', sensitive: true }] });
    expect((await app.inject({ method: 'DELETE', url, headers })).statusCode).toBe(200);
    expect((await profileService.listFacts(user.userId)).find((item) => item.key === 'application.answer_vault.sexual_orientation')).toBeUndefined();
  });

  it('serves a no-store shadow matching page without embedding secrets', async () => {
    const response = await app.inject({ method: 'GET', url: '/shadow-match?profileId=test' });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body).toContain('Check a role against your profile');
    expect(response.body).toContain('Shadow mode is on');
    expect(response.body).not.toContain(adminToken);
    expect(response.body).not.toContain('localStorage');
  });

  it('creates a profile, stores a confirmed fact, and reports remaining categories', async () => {
    const headers = { authorization: `Bearer ${adminToken}` };
    const createResponse = await app.inject({
      method: 'POST',
      url: '/v1/profile/users',
      headers,
      payload: { timezone: 'Europe/London' },
    });
    expect(createResponse.statusCode).toBe(201);
    const { userId } = createResponse.json<{ userId: string }>();

    const factResponse = await app.inject({
      method: 'POST',
      url: '/v1/profile/facts',
      headers,
      payload: {
        userId,
        key: 'preferences.minimum_salary_gbp',
        value: 25_000,
        confirmed: true,
        sensitivity: 'normal',
        usePolicy: 'auto_fill',
        allowedPurposes: ['matching', 'application'],
      },
    });
    expect(factResponse.statusCode).toBe(201);
    expect(factResponse.json()).not.toHaveProperty('value');

    const readiness = await app.inject({
      method: 'GET',
      url: `/v1/profile/${userId}/readiness`,
      headers,
    });
    expect(readiness.statusCode).toBe(200);
    const readinessBody = readiness.json<{
      readyForMatching: boolean;
      missingCategories: string[];
    }>();
    expect(readinessBody.readyForMatching).toBe(false);
    expect(readinessBody.missingCategories).toContain('identity.');
    expect(readinessBody.missingCategories).toContain('contact.');
    expect(readinessBody.missingCategories).toContain('documents.cv');
  });

  it('rejects facts that are not explicitly confirmed', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/profile/facts',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {
        userId: '0199-0000-7000-8000-000000000000',
        key: 'skills.example',
        value: 'unconfirmed',
        confirmed: false,
        sensitivity: 'normal',
        usePolicy: 'auto_fill',
        allowedPurposes: ['matching'],
      },
    });
    expect(response.statusCode).toBe(400);
  });

  it('accepts a confirmed PDF CV into encrypted quarantine without approving it', async () => {
    const headers = { authorization: `Bearer ${adminToken}` };
    const createResponse = await app.inject({
      method: 'POST',
      url: '/v1/profile/users',
      headers,
      payload: { timezone: 'Europe/London' },
    });
    const { userId } = createResponse.json<{ userId: string }>();
    const response = await app.inject({
      method: 'POST',
      url: '/v1/profile/documents/cv',
      headers,
      payload: {
        userId,
        fileName: 'cv.pdf',
        mimeType: 'application/pdf',
        dataBase64: Buffer.from('%PDF-1.7 synthetic test').toString('base64'),
        confirmed: true,
      },
    });
    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({
      type: 'cv',
      version: 1,
      approved: false,
      malwareScanStatus: 'pending',
    });
    expect(response.json()).not.toHaveProperty('objectKey');
  });

  it('checks a public MyJobScotland job in shadow mode without exposing profile values', async () => {
    const user = await profileService.createUser('Europe/London');
    const requiredFacts: Array<[string, unknown]> = [
      ['identity.name', 'Test Applicant'],
      ['contact.email', 'test@example.invalid'],
      ['work_authorisation.gb', { authorised: true }],
      ['preferences.minimum_salary_gbp', 25_000],
      ['preferences.target_roles', ['customer adviser']],
      ['preferences.location', ['Glasgow']],
      ['preferences.work_pattern', ['hybrid']],
      ['preferences.contract_type', ['permanent']],
      ['preferences.hours', ['full time']],
      ['eligibility.notice_period', 'one month'],
      ['employment.history', 'customer service experience'],
      ['education.history', 'reviewed education'],
      ['skills.list', ['customer service']],
      ['documents.cv', { approved: true }],
    ];
    for (const [key, value] of requiredFacts) {
      await profileService.addConfirmedUserFact({
        userId: user.userId,
        key,
        value,
        confirmed: true,
        sensitivity: 'normal',
        usePolicy: 'auto_fill',
        allowedPurposes: ['matching', 'application'],
      });
    }
    const response = await app.inject({
      method: 'POST',
      url: '/v1/shadow-match/myjobscotland',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {
        userId: user.userId,
        url: discoveredJob.canonicalUrl,
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.json()).toMatchObject({
      mode: 'shadow_only',
      applicationActionsEnabled: false,
      job: { id: '489999', title: 'Customer Adviser' },
    });
    expect(response.json()).not.toHaveProperty('facts');
    expect(response.body).not.toContain('test@example.invalid');
    expect(response.json<{ match: { action: string } }>().match.action).not.toBe('auto_apply');
  });
});
