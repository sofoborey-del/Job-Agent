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
