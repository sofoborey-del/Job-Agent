import type { KnowledgeFact } from '@job-agent/domain';
import { SqlSitePolicyStore } from './site-policies.js';
import { DiscoveryService, JobMatchService, type TrackingStores } from '@job-agent/tracking';
import { sourceDefinitionSchema } from '@job-agent/discovery';
import { v7 as uuidv7 } from 'uuid';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTrackingStores } from './stores.js';
import { createMigratedTestDatabase } from './testing.js';
import type { PGliteDatabase } from './sql.js';

type Advert = {
  externalId: string;
  title: string;
  employer: string;
  location: string;
  description: string;
  minSalary: string;
  maxSalary: string;
  closesAt: string;
};

const baseAdvert: Advert = {
  externalId: '489999',
  title: 'Information Governance Officer',
  employer: 'Example Council',
  location: 'Glasgow, G1',
  description:
    '<p>Applicants must have information governance experience.</p><p>A relevant qualification is essential.</p>',
  minSalary: '32000',
  maxSalary: '36000',
  closesAt: '2026-12-03T23:59:59Z',
};

function pageFor(advert: Advert): string {
  return `<!doctype html><html><body>
<script type="application/ld+json">{
  "@context":"https://schema.org",
  "@graph":[{
    "@type":"JobPosting",
    "title":${JSON.stringify(advert.title)},
    "datePosted":"2026-09-20T09:00:00Z",
    "validThrough":${JSON.stringify(advert.closesAt)},
    "employmentType":["FULL_TIME"],
    "baseSalary":{"@type":"MonetaryAmount","currency":"GBP","value":{"@type":"QuantitativeValue","minValue":${JSON.stringify(advert.minSalary)},"maxValue":${JSON.stringify(advert.maxSalary)},"unitText":"YEAR"}},
    "hiringOrganization":{"@type":"Organization","name":${JSON.stringify(advert.employer)}},
    "description":${JSON.stringify(advert.description)}
  }]
}</script>
<div>Location:</div><div>${advert.location}</div>
<div>Salary:</div><div>£32,000 - £36,000 per year</div>
<div>Contract Type:</div><div>Permanent</div>
<div>Hours:</div><div>35 hours per week</div>
<div>Work From Home:</div><div>Hybrid</div>
</body></html>`;
}

function urlFor(advert: Advert): string {
  return `https://myjobscotland.gov.uk/councils/example/jobs/role-${advert.externalId}`;
}

function fetcherFor(adverts: Advert[]): typeof fetch {
  return ((input: string | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    const advert = adverts.find((candidate) => url.startsWith(urlFor(candidate)));
    if (advert === undefined) {
      return Promise.resolve(new Response('not found', { status: 404 }));
    }
    return Promise.resolve(
      new Response(pageFor(advert), { status: 200, headers: { 'content-type': 'text/html' } }),
    );
  }) as unknown as typeof fetch;
}

function verifiedFacts(): KnowledgeFact<unknown>[] {
  const make = (id: string, key: string, value: unknown): KnowledgeFact<unknown> => ({
    id,
    key,
    value,
    status: 'verified',
    source: 'user',
    sensitivity: 'normal',
    usePolicy: 'auto_fill',
    allowedPurposes: ['matching', 'application'],
    version: 1,
  });
  return [
    make(uuidv7(), 'preferences.target_roles', ['information governance officer', 'compliance']),
    make(uuidv7(), 'preferences.location', ['Glasgow', 'Hybrid']),
    make(uuidv7(), 'preferences.contract_type', ['permanent']),
    make(
      uuidv7(),
      'skills.governance',
      'information governance, data protection, compliance, risk, fraud investigation',
    ),
    make(
      uuidv7(),
      'employment.history',
      'Six years in FCA regulated firms covering information governance experience, compliance and corporate risk.',
    ),
    make(
      uuidv7(),
      'certifications_licences.security_plus',
      'CompTIA Security Plus, a relevant qualification for information governance roles',
    ),
    make(uuidv7(), 'work_authorisation.gb', { authorised: true }),
  ];
}

describe('scheduled discovery, deduplication and tracking', () => {
  let database: { db: PGliteDatabase; close: () => Promise<void> };
  let stores: TrackingStores;
  let userId: string;
  const sourceKey = 'myjobscotland_manual';

  const buildDiscovery = (adverts: Advert[]): DiscoveryService =>
    new DiscoveryService({
      stores,
      userId,
      sitePolicyFor: (domain) => new SqlSitePolicyStore(database.db).findByDomain(domain),
      fetcher: fetcherFor(adverts),
      sleep: () => Promise.resolve(),
    });

  beforeEach(async () => {
    database = await createMigratedTestDatabase();
    stores = createTrackingStores(database.db);
    userId = uuidv7();
    await database.db.query(
      `INSERT INTO users (id, timezone, status) VALUES ($1, 'Europe/London', 'active')`,
      [userId],
    );
    await stores.sources.upsertDefinition(
      sourceDefinitionSchema.parse({
        key: sourceKey,
        displayName: 'MyJobScotland saved vacancy links',
        adapterType: 'manual_url_list',
        sitePolicyDomain: 'myjobscotland.gov.uk',
        manualUrls: [urlFor(baseAdvert)],
        enabled: true,
        reviewedBy: 'tests',
        reviewedAt: '2026-09-01T00:00:00.000Z',
      }),
      new Date('2026-09-25T09:00:00.000Z'),
    );
  });

  afterEach(async () => {
    await database.close();
  });

  it('creates one canonical job and stays idempotent when the same slot runs twice', async () => {
    const discovery = buildDiscovery([baseAdvert]);
    const now = new Date('2026-09-25T10:00:00.000Z');
    const first = await discovery.runSource({ sourceKey, trigger: 'scheduled', now });
    expect(first.status).toBe('succeeded');
    expect(first.counts.created).toBe(1);

    const replay = await discovery.runSource({ sourceKey, trigger: 'scheduled', now });
    expect(replay.status).toBe('already_ran');

    const later = await discovery.runSource({
      sourceKey,
      trigger: 'scheduled',
      now: new Date('2026-09-25T20:00:00.000Z'),
    });
    expect(later.counts.created).toBe(0);
    expect(later.counts.unchanged).toBe(1);

    const jobs = await database.db.query<{ total: number }>(
      'SELECT COUNT(*)::int AS total FROM jobs',
    );
    expect(jobs.rows[0]?.total).toBe(1);
  });

  it('does not create a second canonical job when another source lists the same role', async () => {
    const duplicate: Advert = { ...baseAdvert, externalId: '777777' };
    await stores.sources.setManualUrls(sourceKey, [urlFor(baseAdvert), urlFor(duplicate)]);
    const summary = await buildDiscovery([baseAdvert, duplicate]).runSource({
      sourceKey,
      trigger: 'manual',
      now: new Date('2026-09-25T10:00:00.000Z'),
    });
    expect(summary.counts.created).toBe(1);
    expect(summary.counts.duplicates).toBe(1);
    const jobs = await database.db.query<{ total: number }>(
      'SELECT COUNT(*)::int AS total FROM jobs',
    );
    expect(jobs.rows[0]?.total).toBe(1);
  });

  it('records a new job version and a snapshot when the advert text changes', async () => {
    await buildDiscovery([baseAdvert]).runSource({
      sourceKey,
      trigger: 'manual',
      now: new Date('2026-09-25T10:00:00.000Z'),
    });
    const changed: Advert = {
      ...baseAdvert,
      description:
        '<p>Applicants must have information governance experience and SC clearance.</p>',
    };
    const summary = await buildDiscovery([changed]).runSource({
      sourceKey,
      trigger: 'manual',
      now: new Date('2026-09-25T10:10:00.000Z'),
    });
    expect(summary.counts.changed).toBe(1);

    const versions = await database.db.query<{ version: number }>('SELECT version FROM jobs');
    expect(versions.rows[0]?.version).toBe(2);
    const snapshots = await database.db.query<{ total: number }>(
      'SELECT COUNT(*)::int AS total FROM source_job_snapshots',
    );
    expect(snapshots.rows[0]?.total).toBe(2);
    const tracking = await database.db.query<{ lifecycle_status: string; needs_rematch: boolean }>(
      'SELECT lifecycle_status, needs_rematch FROM job_tracking',
    );
    expect(tracking.rows[0]?.lifecycle_status).toBe('changed');
    expect(tracking.rows[0]?.needs_rematch).toBe(true);
  });

  it('marks a vacancy expired once its closing date has passed', async () => {
    const closingSoon: Advert = {
      ...baseAdvert,
      externalId: '222222',
      closesAt: '2026-10-03T23:59:59Z',
    };
    await stores.sources.setManualUrls(sourceKey, [urlFor(closingSoon)]);
    await buildDiscovery([closingSoon]).runSource({
      sourceKey,
      trigger: 'manual',
      now: new Date('2026-09-25T10:00:00.000Z'),
    });
    await buildDiscovery([closingSoon]).runSource({
      sourceKey,
      trigger: 'manual',
      now: new Date('2026-10-10T10:00:00.000Z'),
    });
    const tracking = await database.db.query<{ lifecycle_status: string }>(
      'SELECT lifecycle_status FROM job_tracking',
    );
    expect(tracking.rows[0]?.lifecycle_status).toBe('expired');
  });

  it('refuses to run once the reviewed site policy has expired', async () => {
    const summary = await buildDiscovery([baseAdvert]).runSource({
      sourceKey,
      trigger: 'scheduled',
      now: new Date('2030-01-01T10:00:00.000Z'),
    });
    expect(summary.status).toBe('skipped');
    expect(summary.skipReason).toBe('site_policy_expired');
  });

  it('skips every run while the agent is paused', async () => {
    await stores.runtime.setPaused(true, 'testing', new Date());
    const summary = await buildDiscovery([baseAdvert]).runSource({
      sourceKey,
      trigger: 'scheduled',
      now: new Date('2026-09-25T10:00:00.000Z'),
    });
    expect(summary.status).toBe('skipped');
    expect(summary.skipReason).toBe('agent_paused');
  });

  it('refuses to poll a feed that the reviewed site policy does not cover', async () => {
    await stores.sources.upsertDefinition(
      sourceDefinitionSchema.parse({
        key: 'myjobscotland_feed',
        displayName: 'MyJobScotland feed',
        adapterType: 'public_feed',
        sitePolicyDomain: 'myjobscotland.gov.uk',
        feedUrl: 'https://myjobscotland.gov.uk/feed.xml',
        enabled: true,
        reviewedBy: 'tests',
        reviewedAt: '2026-09-01T00:00:00.000Z',
      }),
      new Date('2026-09-25T09:00:00.000Z'),
    );
    const summary = await buildDiscovery([baseAdvert]).runSource({
      sourceKey: 'myjobscotland_feed',
      trigger: 'scheduled',
      now: new Date('2026-09-25T10:00:00.000Z'),
    });
    expect(summary.status).toBe('skipped');
    expect(summary.skipReason).toBe('feed_discovery_not_reviewed');
  });
});

describe('deterministic matching and notifications', () => {
  let database: { db: PGliteDatabase; close: () => Promise<void> };
  let stores: TrackingStores;
  let userId: string;
  const sourceKey = 'myjobscotland_manual';

  beforeEach(async () => {
    database = await createMigratedTestDatabase();
    stores = createTrackingStores(database.db);
    userId = uuidv7();
    await database.db.query(
      `INSERT INTO users (id, timezone, status) VALUES ($1, 'Europe/London', 'active')`,
      [userId],
    );
    await stores.sources.upsertDefinition(
      sourceDefinitionSchema.parse({
        key: sourceKey,
        displayName: 'MyJobScotland saved vacancy links',
        adapterType: 'manual_url_list',
        sitePolicyDomain: 'myjobscotland.gov.uk',
        manualUrls: [urlFor(baseAdvert)],
        enabled: true,
        reviewedBy: 'tests',
        reviewedAt: '2026-09-01T00:00:00.000Z',
      }),
      new Date('2026-09-25T09:00:00.000Z'),
    );
    await new DiscoveryService({
      stores,
      userId,
      sitePolicyFor: (domain) => new SqlSitePolicyStore(database.db).findByDomain(domain),
      fetcher: fetcherFor([baseAdvert]),
      sleep: () => Promise.resolve(),
    }).runSource({ sourceKey, trigger: 'manual', now: new Date('2026-09-25T10:00:00.000Z') });
  });

  afterEach(async () => {
    await database.close();
  });

  it('stores one reproducible decision and does not re-score unchanged inputs', async () => {
    const service = new JobMatchService({ stores, userId });
    const facts = verifiedFacts();
    const first = await service.matchAwaiting({ facts, now: new Date('2026-09-25T10:05:00.000Z') });
    expect(first.evaluated).toBe(1);

    await database.db.query('UPDATE job_tracking SET needs_rematch = true');
    const second = await service.matchAwaiting({
      facts,
      now: new Date('2026-09-25T10:06:00.000Z'),
    });
    expect(second.evaluated).toBe(0);
    expect(second.reused).toBe(1);

    const runs = await database.db.query<{ total: number }>(
      'SELECT COUNT(*)::int AS total FROM match_runs',
    );
    expect(runs.rows[0]?.total).toBe(1);
  });

  it('records evidence references and a salary result without copying applicant values', async () => {
    await new JobMatchService({ stores, userId }).matchAwaiting({
      facts: verifiedFacts(),
      now: new Date('2026-09-25T10:05:00.000Z'),
    });
    const run = await database.db.query<{
      salary_gate: string;
      explanation_json: unknown;
      score: number;
    }>('SELECT salary_gate, explanation_json, score FROM match_runs');
    expect(run.rows[0]?.salary_gate).toBe('pass');
    const serialised = JSON.stringify(run.rows[0]?.explanation_json);
    expect(serialised).not.toContain('Six years in FCA regulated firms');
    const matches = await database.db.query<{ total: number }>(
      'SELECT COUNT(*)::int AS total FROM requirement_matches',
    );
    expect(matches.rows[0]?.total).toBeGreaterThan(0);
  });

  it('queues exactly one notification for a shortlisted job, however often matching runs', async () => {
    const service = new JobMatchService({ stores, userId });
    const facts = verifiedFacts();
    await service.matchAwaiting({ facts, now: new Date('2026-09-25T10:05:00.000Z') });
    await database.db.query('UPDATE job_tracking SET needs_rematch = true');
    await service.matchAwaiting({ facts, now: new Date('2026-09-25T10:06:00.000Z') });
    const events = await database.db.query<{ total: number }>(
      `SELECT COUNT(*)::int AS total FROM outbox_events WHERE event_type = 'JOB_MATCHED'`,
    );
    expect(events.rows[0]?.total).toBe(1);
  });

  it('keeps a decision the user made rather than overwriting it automatically', async () => {
    const jobs = await database.db.query<{ id: string }>('SELECT id FROM jobs LIMIT 1');
    const jobId = jobs.rows[0]?.id ?? '';
    await stores.tracking.changeReviewStatus({
      userId,
      jobId,
      to: 'rejected',
      actor: 'user',
      decidedBy: 'user',
      reason: 'not interested',
      correlationId: uuidv7(),
      now: new Date('2026-09-25T10:04:00.000Z'),
    });
    await new JobMatchService({ stores, userId }).matchAwaiting({
      facts: verifiedFacts(),
      now: new Date('2026-09-25T10:05:00.000Z'),
    });
    const tracking = await database.db.query<{ review_status: string; decided_by: string }>(
      'SELECT review_status, decided_by FROM job_tracking',
    );
    expect(tracking.rows[0]?.review_status).toBe('rejected');
    expect(tracking.rows[0]?.decided_by).toBe('user');
  });

  it('filters the tracker by status, score, employer, location, salary, date and source', async () => {
    await new JobMatchService({ stores, userId }).matchAwaiting({
      facts: verifiedFacts(),
      now: new Date('2026-09-25T10:05:00.000Z'),
    });
    const page = await stores.tracking.list({
      userId,
      minScore: 1,
      employer: 'Example',
      location: 'Glasgow',
      minSalaryMinor: 2_500_000,
      discoveredFrom: '2026-09-01T00:00:00.000Z',
      sourceKeys: [sourceKey],
      sort: 'score_desc',
    });
    expect(page.total).toBe(1);
    expect(page.jobs[0]?.employer).toBe('Example Council');

    const wrongEmployer = await stores.tracking.list({ userId, employer: 'Nowhere' });
    expect(wrongEmployer.total).toBe(0);
    const tooExpensive = await stores.tracking.list({ userId, minSalaryMinor: 9_000_000 });
    expect(tooExpensive.total).toBe(0);
  });
});
