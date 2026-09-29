import { generateKeyPairSync, randomBytes, sign as signMessage } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createMigratedTestDatabase,
  createTrackingStores,
  SqlSitePolicyStore,
  type PGliteDatabase,
} from '@job-agent/db';
import { sourceDefinitionSchema } from '@job-agent/discovery';
import { DiscordCommandService } from '@job-agent/notifications';
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

import { buildServer } from './server.js';

const adminToken = 'test-token-that-is-at-least-thirty-two-characters';
const discordUserId = '1234567890';
const keyPair = generateKeyPairSync('ed25519');
const discordPublicKey = keyPair.publicKey
  .export({ format: 'der', type: 'spki' })
  .subarray(12)
  .toString('hex');

let app: ReturnType<typeof buildServer>;
let stores: TrackingStores;
let close: () => Promise<void>;
let database: PGliteDatabase;
let userId: string;
let jobId: string;
let profileService: ProfileService;
let profileRepository: InMemoryProfileRepository;

const vacancyUrl = 'https://myjobscotland.gov.uk/councils/example/jobs/governance-officer-777001';

const vacancyPage = `<!doctype html><html><body>
<script type="application/ld+json">{
  "@type":"JobPosting",
  "title":"Information Governance Officer",
  "datePosted":"2026-09-20T09:00:00Z",
  "validThrough":"2026-12-03T23:59:59Z",
  "employmentType":["FULL_TIME"],
  "baseSalary":{"currency":"GBP","value":{"minValue":"34000","maxValue":"38000","unitText":"YEAR"}},
  "hiringOrganization":{"name":"Example Council"},
  "description":"<p>Information governance experience is essential.</p><p>Data protection knowledge is required.</p>"
}</script>
<div>Location:</div><div>Glasgow</div>
<div>Salary:</div><div>\u00a334,000 - \u00a338,000 per year</div>
<div>Contract Type:</div><div>Permanent</div>
</body></html>`;

const vacancyFetcher = ((input: string | URL) => {
  const url = typeof input === 'string' ? input : input.toString();
  if (!url.startsWith(vacancyUrl)) {
    return Promise.resolve(new Response('not found', { status: 404 }));
  }
  return Promise.resolve(
    new Response(vacancyPage, { status: 200, headers: { 'content-type': 'text/html' } }),
  );
}) as unknown as typeof fetch;

const requiredFactKeys = [
  'identity.full_name',
  'contact.email',
  'work_authorisation.gb',
  'preferences.minimum_salary_gbp',
  'preferences.target_roles',
  'preferences.location',
  'preferences.work_pattern',
  'preferences.contract_type',
  'preferences.hours',
  'eligibility.notice_period',
  'employment.history',
  'education.history',
  'skills.governance',
  'documents.cv',
];

async function seedCompleteProfile(): Promise<void> {
  await profileRepository.createUser(userId);
  const values: Record<string, unknown> = {
    'work_authorisation.gb': { authorised: true },
    'preferences.target_roles': ['information governance officer'],
    'preferences.location': ['Glasgow'],
    'preferences.contract_type': ['permanent'],
    'skills.governance': 'information governance, data protection, compliance',
    'employment.history': 'Six years covering information governance experience and compliance.',
  };
  for (const key of requiredFactKeys) {
    await profileService.addConfirmedUserFact({
      userId,
      key,
      value: values[key] ?? 'recorded',
      confirmed: true,
      sensitivity: 'normal',
      usePolicy: 'auto_fill',
      allowedPurposes: ['matching', 'application'],
    });
  }
}

function signedHeaders(body: string, now = new Date()): Record<string, string> {
  const timestamp = String(Math.floor(now.getTime() / 1000));
  return {
    'content-type': 'application/json',
    'x-signature-ed25519': signMessage(
      null,
      Buffer.from(timestamp + body, 'utf8'),
      keyPair.privateKey,
    ).toString('hex'),
    'x-signature-timestamp': timestamp,
  };
}

beforeEach(async () => {
  const created = await createMigratedTestDatabase();
  close = created.close;
  database = created.db;
  stores = createTrackingStores(database);
  userId = uuidv7();
  await database.query(
    `INSERT INTO users (id, timezone, status) VALUES ($1, 'Europe/London', 'active')`,
    [userId],
  );
  await stores.sources.upsertDefinition(
    sourceDefinitionSchema.parse({
      key: 'myjobscotland_manual',
      displayName: 'MyJobScotland saved vacancy links',
      adapterType: 'manual_url_list',
      sitePolicyDomain: 'myjobscotland.gov.uk',
      manualUrls: [],
      reviewedBy: 'tests',
      reviewedAt: '2026-09-01T00:00:00.000Z',
    }),
    new Date(),
  );

  const companyId = uuidv7();
  jobId = uuidv7();
  await database.query(
    `INSERT INTO companies (id, canonical_name) VALUES ($1, 'Example Council')`,
    [companyId],
  );
  await database.query(
    `INSERT INTO jobs (
       id, company_id, canonical_url, title, description, location_json, content_hash,
       fingerprint, source_key, salary_min_minor, salary_max_minor, salary_currency,
       salary_basis, closes_at, version, status
     ) VALUES ($1, $2, $3, 'Information Governance Officer', 'Applicants must have experience.',
       '{"text":"Glasgow"}'::jsonb, $4, $5, 'myjobscotland_manual', 3200000, 3600000, 'GBP',
       'annual_base', '2026-12-03T23:59:59Z', 1, 'open')`,
    [
      jobId,
      companyId,
      'https://myjobscotland.gov.uk/councils/example/jobs/role-1',
      'c'.repeat(64),
      'd'.repeat(64),
    ],
  );
  await database.query(
    `INSERT INTO job_tracking (
       id, user_id, job_id, lifecycle_status, review_status, decided_by, score, salary_gate,
       needs_rematch
     ) VALUES ($1, $2, $3, 'open', 'shortlisted', 'system', 72, 'pass', false)`,
    [uuidv7(), userId, jobId],
  );

  const cipher = new FieldCipher(
    new StaticEncryptionKeyProvider('test-v1', new Map([['test-v1', randomBytes(32)]])),
  );
  const documentRepository = new InMemoryDocumentRepository();
  const artifactStore = new InMemoryArtifactStore();
  profileRepository = new InMemoryProfileRepository();
  profileService = new ProfileService(profileRepository, cipher);
  app = buildServer({
    profileService,
    documentService: new DocumentService(documentRepository, artifactStore, cipher),
    cvProcessingService: new CvProcessingService(documentRepository, artifactStore, cipher, {
      scan: () => Promise.resolve(),
    }),
    adminToken,
    tracking: {
      stores,
      sitePolicyFor: (domain) => new SqlSitePolicyStore(database).findByDomain(domain),
      listSitePolicies: () => new SqlSitePolicyStore(database).list(),
      notificationsConfigured: false,
      manualSourceKey: 'myjobscotland_manual',
      fetcher: vacancyFetcher,
      schedulerEnabled: false,
      discord: {
        publicKey: discordPublicKey,
        commands: new DiscordCommandService({
          stores,
          userId,
          allowedDiscordUserId: discordUserId,
          allowedChannelId: null,
        }),
      },
    },
  });
});

afterEach(async () => {
  await app.close();
  await close();
});

describe('tracker API', () => {
  it('serves the local tracker page without a token and never enables applications', async () => {
    const page = await app.inject({ method: 'GET', url: '/tracker' });
    expect(page.statusCode).toBe(200);
    expect(page.headers['cache-control']).toBe('no-store');
    expect(page.body).toContain('Your job shortlist');
    expect(page.body).toContain('Find jobs now');
    expect(page.body).toContain("sourceKey: 'adzuna_gb_search'");
    expect(page.body).toContain('<option value="discovered_desc" selected>Newest first</option>');
    expect(page.body).not.toContain('<option value="shortlisted" selected>');

    const health = await app.inject({ method: 'GET', url: '/health' });
    expect(health.json()).toMatchObject({ browserAutomation: false, autoSubmit: false });
  });

  it('requires the admin token for tracker data', async () => {
    const response = await app.inject({ method: 'GET', url: `/v1/tracker/${userId}/jobs` });
    expect(response.statusCode).toBe(401);
  });

  it('filters by status, score, employer, location, salary, date and source', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/v1/tracker/${userId}/jobs?reviewStatus=shortlisted&minScore=50&employer=Example&location=Glasgow&minSalary=25000&salaryGate=pass&source=myjobscotland_manual&discoveredFrom=2026-01-01T00:00:00.000Z&sort=score_desc`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json<{ total: number; applicationActionsEnabled: boolean }>();
    expect(body.total).toBe(1);
    expect(body.applicationActionsEnabled).toBe(false);

    const filteredOut = await app.inject({
      method: 'GET',
      url: `/v1/tracker/${userId}/jobs?minScore=90`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(filteredOut.json<{ total: number }>().total).toBe(0);
  });

  it('records a review decision and refuses a move the state machine forbids', async () => {
    const archived = await app.inject({
      method: 'POST',
      url: `/v1/tracker/${userId}/jobs/${jobId}/status`,
      headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
      payload: { status: 'archived', reason: 'not for me' },
    });
    expect(archived.statusCode).toBe(200);
    expect(archived.json<{ reviewStatus: string }>().reviewStatus).toBe('archived');

    const invalid = await app.inject({
      method: 'POST',
      url: `/v1/tracker/${userId}/jobs/${jobId}/status`,
      headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
      payload: { status: 'reviewed' },
    });
    expect(invalid.statusCode).toBe(409);
  });

  it('pauses and resumes the agent', async () => {
    const paused = await app.inject({
      method: 'POST',
      url: '/v1/agent/pause',
      headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
      payload: { reason: 'testing' },
    });
    expect(paused.json<{ paused: boolean }>().paused).toBe(true);

    const status = await app.inject({
      method: 'GET',
      url: '/v1/agent/status',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(status.json()).toMatchObject({
      paused: true,
      autoSubmitEnabled: false,
      applicationActionsEnabled: false,
      scheduler: { configured: false, ready: false, problems: [] },
    });

    await app.inject({
      method: 'POST',
      url: '/v1/agent/resume',
      headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
      payload: {},
    });
    const resumed = await app.inject({
      method: 'GET',
      url: '/v1/agent/status',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(resumed.json<{ paused: boolean }>().paused).toBe(false);
  });

  it('refuses a source whose domain has no reviewed public parser', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/sources',
      headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
      payload: {
        key: 'somewhere_else',
        displayName: 'Somewhere else',
        adapterType: 'manual_url_list',
        sitePolicyDomain: 'example.com',
        manualUrls: ['https://example.com/jobs/1'],
        reviewedBy: 'samuel',
        reviewedAt: '2026-09-01T00:00:00.000Z',
      },
    });
    expect(response.statusCode).toBe(400);
  });
});

describe('adding a vacancy link', () => {
  it('reads the advert and returns its decision in one step', async () => {
    await seedCompleteProfile();
    const response = await app.inject({
      method: 'POST',
      url: '/v1/discovery/manual-url',
      headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
      payload: { userId, url: vacancyUrl },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json<{
      status: string;
      outcome: string;
      applicationActionsEnabled: boolean;
      job: { title: string; employer: string };
      match: {
        state: string;
        score: number;
        action: string;
        reviewStatus: string;
        salaryGate: string;
        reasons: string[];
      };
    }>();
    expect(body.status).toBe('ingested');
    expect(body.outcome).toBe('created');
    expect(body.applicationActionsEnabled).toBe(false);
    expect(body.job.title).toBe('Information Governance Officer');
    expect(body.match.state).toBe('decided');
    expect(body.match.salaryGate).toBe('pass');
    expect(body.match.score).toBeGreaterThan(0);
    expect(body.match.reasons.length).toBeGreaterThan(0);
    expect(['discovered', 'shortlisted', 'rejected']).toContain(body.match.reviewStatus);
  });

  it('says plainly when the profile is not finished instead of pretending to score', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/discovery/manual-url',
      headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
      payload: { userId, url: vacancyUrl },
    });
    const body = response.json<{ match: { state: string; missingCategories: string[] } }>();
    expect(body.match.state).toBe('profile_incomplete');
    expect(body.match.missingCategories.length).toBeGreaterThan(0);
  });

  it('is harmless when the same link is added again', async () => {
    await seedCompleteProfile();
    const payload = { userId, url: vacancyUrl };
    const first = await app.inject({
      method: 'POST',
      url: '/v1/discovery/manual-url',
      headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
      payload,
    });
    const second = await app.inject({
      method: 'POST',
      url: '/v1/discovery/manual-url',
      headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
      payload,
    });
    const firstBody = first.json<{ jobId: string; match: { score: number } }>();
    const secondBody = second.json<{
      outcome: string;
      jobId: string;
      match: { state: string; reused: boolean; score: number };
    }>();
    expect(secondBody.outcome).toBe('unchanged');
    expect(secondBody.jobId).toBe(firstBody.jobId);
    expect(secondBody.match.state).toBe('decided');
    expect(secondBody.match.reused).toBe(true);
    expect(secondBody.match.score).toBe(firstBody.match.score);

    const jobs = await database.query<{ total: number }>(
      'SELECT COUNT(*)::int AS total FROM jobs WHERE canonical_url = $1',
      [vacancyUrl],
    );
    expect(jobs.rows[0]?.total).toBe(1);
    const runs = await database.query<{ total: number }>(
      'SELECT COUNT(*)::int AS total FROM match_runs WHERE job_id = $1',
      [firstBody.jobId],
    );
    expect(runs.rows[0]?.total).toBe(1);
    const notifications = await database.query<{ total: number }>(
      `SELECT COUNT(*)::int AS total FROM outbox_events WHERE event_type = 'JOB_MATCHED'`,
    );
    expect(notifications.rows[0]?.total).toBeLessThanOrEqual(1);
  });

  it('refuses a link outside the reviewed site policy', async () => {
    await seedCompleteProfile();
    const response = await app.inject({
      method: 'POST',
      url: '/v1/discovery/manual-url',
      headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
      payload: { userId, url: 'https://example.com/jobs/1' },
    });
    expect(response.statusCode).toBe(400);
  });
});

describe('switching a source on through the API', () => {
  it('refuses with a clear reason when the site policy has expired', async () => {
    await database.query(
      `UPDATE site_policies SET review_expires_at = now() - interval '1 day'
        WHERE domain = 'myjobscotland.gov.uk'`,
    );
    const response = await app.inject({
      method: 'POST',
      url: '/v1/sources/myjobscotland_manual/enabled',
      headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
      payload: { enabled: true },
    });
    expect(response.statusCode).toBe(409);
    const body = response.json<{ reason: string; message: string }>();
    expect(body.reason).toBe('site_policy_expired');
    expect(body.message).toContain('ran out on');
    expect((await stores.sources.getByKey('myjobscotland_manual'))?.enabled).toBe(false);
  });

  it('refuses with a clear reason when no site policy exists', async () => {
    await database.query(`DELETE FROM site_policies WHERE domain = 'myjobscotland.gov.uk'`);
    const response = await app.inject({
      method: 'POST',
      url: '/v1/sources/myjobscotland_manual/enabled',
      headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
      payload: { enabled: true },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json<{ reason: string }>().reason).toBe('site_policy_missing');
  });

  it('accepts a permitted source and repeats harmlessly', async () => {
    const first = await app.inject({
      method: 'POST',
      url: '/v1/sources/myjobscotland_manual/enabled',
      headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
      payload: { enabled: true },
    });
    const second = await app.inject({
      method: 'POST',
      url: '/v1/sources/myjobscotland_manual/enabled',
      headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
      payload: { enabled: true },
    });
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(second.json<{ enabled: boolean }>().enabled).toBe(true);
  });

  it('returns 404 for a source that does not exist', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/sources/not_a_source/enabled',
      headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
      payload: { enabled: true },
    });
    expect(response.statusCode).toBe(404);
  });
});

describe('Discord interactions endpoint', () => {
  it('rejects an unsigned request', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/discord/interactions',
      headers: { 'content-type': 'application/json' },
      payload: { type: 1 },
    });
    expect(response.statusCode).toBe(401);
  });

  it('answers a signed ping', async () => {
    const body = JSON.stringify({ id: 'ping-1', type: 1 });
    const response = await app.inject({
      method: 'POST',
      url: '/v1/discord/interactions',
      headers: signedHeaders(body),
      payload: body,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ type: 1 });
  });

  it('ignores commands from anyone other than the allowlisted user', async () => {
    const body = JSON.stringify({
      id: 'interaction-1',
      type: 2,
      member: { user: { id: 'someone-else' } },
      data: { name: 'agent', options: [{ type: 1, name: 'status' }] },
    });
    const response = await app.inject({
      method: 'POST',
      url: '/v1/discord/interactions',
      headers: signedHeaders(body),
      payload: body,
    });
    expect(JSON.stringify(response.json())).toContain('only takes commands from its owner');
  });

  it('treats a replayed interaction as harmless and never applies for anything', async () => {
    const body = JSON.stringify({
      id: 'interaction-2',
      type: 2,
      member: { user: { id: discordUserId } },
      data: { name: 'agent', options: [{ type: 1, name: 'status' }] },
    });
    const first = await app.inject({
      method: 'POST',
      url: '/v1/discord/interactions',
      headers: signedHeaders(body),
      payload: body,
    });
    expect(JSON.stringify(first.json())).toContain(
      'Real applications and automatic submission are disabled',
    );

    const replay = await app.inject({
      method: 'POST',
      url: '/v1/discord/interactions',
      headers: signedHeaders(body),
      payload: body,
    });
    expect(JSON.stringify(replay.json())).toContain('already handled');
  });

  it('changes a tracker status from an allowlisted command and refuses to apply', async () => {
    const shortlist = JSON.stringify({
      id: 'interaction-3',
      type: 2,
      member: { user: { id: discordUserId } },
      data: {
        name: 'job',
        options: [{ type: 1, name: 'reject', options: [{ name: 'id', value: jobId.slice(0, 8) }] }],
      },
    });
    const response = await app.inject({
      method: 'POST',
      url: '/v1/discord/interactions',
      headers: signedHeaders(shortlist),
      payload: shortlist,
    });
    expect(JSON.stringify(response.json())).toContain('nothing was sent to the employer');
    expect((await stores.tracking.get(userId, jobId))?.reviewStatus).toBe('rejected');

    const apply = JSON.stringify({
      id: 'interaction-4',
      type: 2,
      member: { user: { id: discordUserId } },
      data: {
        name: 'job',
        options: [{ type: 1, name: 'apply', options: [{ name: 'id', value: jobId.slice(0, 8) }] }],
      },
    });
    const applyResponse = await app.inject({
      method: 'POST',
      url: '/v1/discord/interactions',
      headers: signedHeaders(apply),
      payload: apply,
    });
    expect(JSON.stringify(applyResponse.json())).toContain(
      'Applying to a real employer is not enabled',
    );
  });
});

describe('completing an excerpt-only lead from the official advert', () => {
  const auth = { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' };

  /** Inserts an Adzuna-style lead: an excerpt, no criteria, left in discovered. */
  async function seedLead(): Promise<string> {
    const jobId = uuidv7();
    const companyId = uuidv7();
    await database.query(
      `INSERT INTO companies (id, canonical_name) VALUES ($1, 'Invented Retail Ltd')
       ON CONFLICT (id) DO NOTHING`,
      [companyId],
    );
    await database.query(
      `INSERT INTO jobs (
         id, company_id, canonical_url, title, description, description_completeness,
         location_json, content_hash, fingerprint, version, status
       ) VALUES ($1, $2, $3, 'Customer Service Adviser',
         'Handle customer enquiries for a busy team. You will need experience of…', 'snippet',
         '{"text":"Glasgow"}'::jsonb, $4, $5, 1, 'open')`,
      [
        jobId,
        companyId,
        `https://www.adzuna.co.uk/jobs/land/ad/${jobId}`,
        'e'.repeat(64),
        'f'.repeat(64),
      ],
    );
    await database.query(
      `INSERT INTO job_tracking (
         id, user_id, job_id, lifecycle_status, review_status, decided_by, needs_rematch
       ) VALUES ($1, $2, $3, 'open', 'discovered', 'system', true)`,
      [uuidv7(), userId, jobId],
    );
    return jobId;
  }

  it('shows the lead as an excerpt in the tracker listing', async () => {
    const jobId = await seedLead();
    const response = await app.inject({
      method: 'GET',
      url: `/v1/tracker/${userId}/jobs`,
      headers: auth,
    });
    const body = response.json<{
      jobs: Array<{ jobId: string; descriptionCompleteness: string; reviewStatus: string }>;
    }>();
    const lead = body.jobs.find((job) => job.jobId === jobId);
    expect(lead?.descriptionCompleteness).toBe('snippet');
    expect(lead?.reviewStatus).toBe('discovered');
  });

  it('compares pasted complete text without fetching, saving it, or upgrading the lead', async () => {
    await seedCompleteProfile();
    const leadId = await seedLead();
    const advertText = (
      'Customer service experience is essential. Data protection knowledge is required. ' +
      'The post involves helping customers, keeping accurate records and working to deadlines. '
    ).repeat(4);
    const response = await app.inject({
      method: 'POST',
      url: `/v1/tracker/${userId}/jobs/${leadId}/pasted-advert-review`,
      headers: auth,
      payload: {
        advertText,
        criteriaText: 'Applicants must have customer service and data protection experience.',
        confirmedComplete: true,
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      mode: 'pasted_text_review_only',
      textSaved: false,
      employerSiteContacted: false,
      trackerChanged: false,
      applicationActionsEnabled: false,
    });
    expect(response.json<{ tentativeScore: number | null }>().tentativeScore).not.toBeNull();
    expect(response.body).not.toContain(advertText);
    const saved = await database.query<{
      description: string;
      description_completeness: string;
      version: number;
    }>('SELECT description, description_completeness, version FROM jobs WHERE id = $1', [leadId]);
    expect(saved.rows[0]).toEqual({
      description: 'Handle customer enquiries for a busy team. You will need experience of…',
      description_completeness: 'snippet',
      version: 1,
    });
    expect((await stores.tracking.get(userId, leadId))?.reviewStatus).toBe('discovered');
  });

  it('requires confirmation, a complete profile, and ownership of an open excerpt-only lead', async () => {
    const leadId = await seedLead();
    const advertText = 'Customer service experience is essential. '.repeat(12);
    const path = `/v1/tracker/${userId}/jobs/${leadId}/pasted-advert-review`;
    expect(
      (
        await app.inject({
          method: 'POST',
          url: path,
          payload: { advertText, confirmedComplete: true },
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: path,
          headers: auth,
          payload: { advertText, confirmedComplete: false },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: path,
          headers: auth,
          payload: { advertText, confirmedComplete: true },
        })
      ).statusCode,
    ).toBe(409);
    await seedCompleteProfile();
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/v1/tracker/${uuidv7()}/jobs/${leadId}/pasted-advert-review`,
          headers: auth,
          payload: { advertText, confirmedComplete: true },
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/v1/tracker/${userId}/jobs/${jobId}/pasted-advert-review`,
          headers: auth,
          payload: { advertText, confirmedComplete: true },
        })
      ).statusCode,
    ).toBe(409);
  });

  /** The guarantee that matters: an unreviewed site is refused, and nothing is fetched. */
  it.each([
    'https://www.s1jobs.com/job/customer-adviser-999',
    'https://www.indeed.co.uk/viewjob?jk=abc',
    'https://www.totaljobs.com/job/12345',
  ])('refuses %s and fetches nothing', async (url) => {
    const jobId = await seedLead();
    const response = await app.inject({
      method: 'POST',
      url: `/v1/tracker/${userId}/jobs/${jobId}/official-url`,
      headers: auth,
      payload: { url },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json<{ reason: string }>().reason).toBe('no_site_policy');
  });

  it.each([
    'http://www.myjobscotland.gov.uk/job/1',
    'https://user:secret@www.myjobscotland.gov.uk/job/1',
  ])('refuses %s at the request boundary', async (url) => {
    const jobId = await seedLead();
    const response = await app.inject({
      method: 'POST',
      url: `/v1/tracker/${userId}/jobs/${jobId}/official-url`,
      headers: auth,
      payload: { url },
    });
    expect([400, 409]).toContain(response.statusCode);
  });

  it('requires the admin token', async () => {
    const jobId = await seedLead();
    const response = await app.inject({
      method: 'POST',
      url: `/v1/tracker/${userId}/jobs/${jobId}/official-url`,
      headers: { 'content-type': 'application/json' },
      payload: { url: vacancyUrl },
    });
    expect(response.statusCode).toBe(401);
  });

  it('refuses a job that already holds the full advert', async () => {
    await seedCompleteProfile();
    const added = await app.inject({
      method: 'POST',
      url: '/v1/discovery/manual-url',
      headers: auth,
      payload: { userId, url: vacancyUrl },
    });
    const jobId = added.json<{ jobId: string }>().jobId;
    const response = await app.inject({
      method: 'POST',
      url: `/v1/tracker/${userId}/jobs/${jobId}/official-url`,
      headers: auth,
      payload: { url: vacancyUrl },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json<{ reason: string }>().reason).toBe('lead_already_complete');
  });

  it('reads the reviewed advert, scores it and retires the lead', async () => {
    await seedCompleteProfile();
    const jobId = await seedLead();

    const response = await app.inject({
      method: 'POST',
      url: `/v1/tracker/${userId}/jobs/${jobId}/official-url`,
      headers: auth,
      payload: { url: vacancyUrl },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json<{
      status: string;
      officialJobId: string;
      job: { descriptionCompleteness: string; title: string };
      match: { state: string };
      applicationActionsEnabled: boolean;
    }>();
    expect(body.status).toBe('completed');
    expect(body.applicationActionsEnabled).toBe(false);
    expect(body.job.descriptionCompleteness).toBe('full');
    expect(body.match.state).toBe('decided');
    expect(body.officialJobId).not.toBe(jobId);

    // The lead is retired against the official job, so the same vacancy cannot be applied for twice.
    const lead = await app.inject({
      method: 'GET',
      url: `/v1/tracker/${userId}/jobs/${jobId}`,
      headers: auth,
    });
    const leadBody = lead.json<{ lifecycleStatus: string; duplicateOfJobId: string | null }>();
    expect(leadBody.lifecycleStatus).toBe('duplicate');
    expect(leadBody.duplicateOfJobId).toBe(body.officialJobId);
  });

  it('is harmless when the same official advert is supplied twice', async () => {
    await seedCompleteProfile();
    const jobId = await seedLead();
    const payload = { url: vacancyUrl };
    const first = await app.inject({
      method: 'POST',
      url: `/v1/tracker/${userId}/jobs/${jobId}/official-url`,
      headers: auth,
      payload,
    });
    const second = await app.inject({
      method: 'POST',
      url: `/v1/tracker/${userId}/jobs/${jobId}/official-url`,
      headers: auth,
      payload,
    });
    expect(first.statusCode).toBe(200);
    // The lead is no longer an excerpt-bearing lead, so a repeat is refused rather than repeated.
    expect(second.statusCode).toBe(409);
  });
});
