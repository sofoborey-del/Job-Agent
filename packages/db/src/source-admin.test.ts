import type { KnowledgeFact } from '@job-agent/domain';
import { sourceDefinitionSchema } from '@job-agent/discovery';
import {
  SchedulerReadinessService,
  SourceAdminService,
  SourceEnableRefusedError,
  type TrackingStores,
} from '@job-agent/tracking';
import { v7 as uuidv7 } from 'uuid';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SqlSitePolicyStore } from './site-policies.js';
import type { PGliteDatabase } from './sql.js';
import { createTrackingStores } from './stores.js';
import { createMigratedTestDatabase } from './testing.js';

const MANUAL_KEY = 'myjobscotland_manual';
const FEED_KEY = 'myjobscotland_feed';

function manualDefinition(overrides: Record<string, unknown> = {}) {
  return sourceDefinitionSchema.parse({
    key: MANUAL_KEY,
    displayName: 'MyJobScotland saved vacancy links',
    adapterType: 'manual_url_list',
    sitePolicyDomain: 'myjobscotland.gov.uk',
    manualUrls: ['https://myjobscotland.gov.uk/councils/example/jobs/role-1'],
    reviewedBy: 'tests',
    reviewedAt: '2026-09-01T00:00:00.000Z',
    ...overrides,
  });
}

function completeProfile(): KnowledgeFact<unknown>[] {
  const keys = [
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
  return keys.map((key) => ({
    id: uuidv7(),
    key,
    value: 'recorded',
    status: 'verified',
    source: 'user',
    sensitivity: 'normal',
    usePolicy: 'auto_fill',
    allowedPurposes: ['matching', 'application'],
    version: 1,
  }));
}

describe('switching a discovery source on', () => {
  let database: { db: PGliteDatabase; close: () => Promise<void> };
  let stores: TrackingStores;
  let admin: SourceAdminService;

  beforeEach(async () => {
    database = await createMigratedTestDatabase();
    stores = createTrackingStores(database.db);
    admin = new SourceAdminService({
      stores,
      sitePolicyFor: (domain) => new SqlSitePolicyStore(database.db).findByDomain(domain),
    });
    await stores.sources.upsertDefinition(manualDefinition(), new Date('2026-09-25T09:00:00.000Z'));
  });

  afterEach(async () => {
    await database.close();
  });

  it('switches on a source whose reviewed policy is current and permits the action', async () => {
    const result = await admin.setEnabled({
      sourceKey: MANUAL_KEY,
      enabled: true,
      now: new Date('2026-09-25T10:00:00.000Z'),
    });
    expect(result.source.enabled).toBe(true);
    expect(result.warnings).toEqual([]);
  });

  it('refuses when no reviewed site policy exists for the domain', async () => {
    await database.db.query(`DELETE FROM site_policies WHERE domain = 'myjobscotland.gov.uk'`);
    await expect(admin.setEnabled({ sourceKey: MANUAL_KEY, enabled: true })).rejects.toMatchObject({
      reason: 'site_policy_missing',
    });
    expect((await stores.sources.getByKey(MANUAL_KEY))?.enabled).toBe(false);
  });

  it('refuses when the site policy review has run out', async () => {
    await database.db.query(
      `UPDATE site_policies SET review_expires_at = now() - interval '1 day'
        WHERE domain = 'myjobscotland.gov.uk'`,
    );
    const error = await admin
      .setEnabled({ sourceKey: MANUAL_KEY, enabled: true })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SourceEnableRefusedError);
    expect((error as SourceEnableRefusedError).reason).toBe('site_policy_expired');
    expect((error as SourceEnableRefusedError).message).toContain('ran out on');
    expect((await stores.sources.getByKey(MANUAL_KEY))?.enabled).toBe(false);
  });

  it('refuses when the reviewed terms prohibit automated access', async () => {
    await database.db.query(
      `UPDATE site_policies SET terms_status = 'reviewed_prohibited'
        WHERE domain = 'myjobscotland.gov.uk'`,
    );
    await expect(admin.setEnabled({ sourceKey: MANUAL_KEY, enabled: true })).rejects.toMatchObject({
      reason: 'site_policy_disabled',
    });
  });

  it('refuses when the terms have not been reviewed at all', async () => {
    await database.db.query(
      `UPDATE site_policies SET terms_status = 'unknown' WHERE domain = 'myjobscotland.gov.uk'`,
    );
    await expect(admin.setEnabled({ sourceKey: MANUAL_KEY, enabled: true })).rejects.toMatchObject({
      reason: 'site_policy_unknown',
    });
  });

  it('refuses to poll a feed the reviewed policy does not cover', async () => {
    await stores.sources.upsertDefinition(
      sourceDefinitionSchema.parse({
        key: FEED_KEY,
        displayName: 'MyJobScotland feed',
        adapterType: 'public_feed',
        sitePolicyDomain: 'myjobscotland.gov.uk',
        feedUrl: 'https://myjobscotland.gov.uk/feed.xml',
        reviewedBy: 'tests',
        reviewedAt: '2026-09-01T00:00:00.000Z',
      }),
      new Date('2026-09-25T09:00:00.000Z'),
    );
    await expect(admin.setEnabled({ sourceKey: FEED_KEY, enabled: true })).rejects.toMatchObject({
      reason: 'feed_discovery_not_reviewed',
    });
  });

  it('refuses a feed source that has no configured feed address', async () => {
    await database.db.query(
      `UPDATE site_policies SET discovery_mode = 'feed' WHERE domain = 'myjobscotland.gov.uk'`,
    );
    await stores.sources.upsertDefinition(
      sourceDefinitionSchema.parse({
        key: FEED_KEY,
        displayName: 'MyJobScotland feed',
        adapterType: 'public_feed',
        sitePolicyDomain: 'myjobscotland.gov.uk',
        feedUrl: 'https://myjobscotland.gov.uk/feed.xml',
        reviewedBy: 'tests',
        reviewedAt: '2026-09-01T00:00:00.000Z',
      }),
      new Date('2026-09-25T09:00:00.000Z'),
    );
    await database.db.query(`UPDATE sources SET feed_url = NULL WHERE source_key = $1`, [FEED_KEY]);
    await expect(admin.setEnabled({ sourceKey: FEED_KEY, enabled: true })).rejects.toMatchObject({
      reason: 'feed_url_missing',
    });
  });

  it('warns rather than refuses when a manual source has no saved links yet', async () => {
    await stores.sources.setManualUrls(MANUAL_KEY, []);
    const result = await admin.setEnabled({ sourceKey: MANUAL_KEY, enabled: true });
    expect(result.source.enabled).toBe(true);
    expect(result.warnings[0]).toContain('no saved vacancy links');
  });

  it('treats repeated switch-on requests as harmless', async () => {
    const first = await admin.setEnabled({ sourceKey: MANUAL_KEY, enabled: true });
    const second = await admin.setEnabled({ sourceKey: MANUAL_KEY, enabled: true });
    expect(first.source.enabled).toBe(true);
    expect(second.source.enabled).toBe(true);
    const rows = await database.db.query<{ total: number }>(
      `SELECT COUNT(*)::int AS total FROM sources WHERE source_key = $1`,
      [MANUAL_KEY],
    );
    expect(rows.rows[0]?.total).toBe(1);
  });

  it('always allows switching a source off, even with an expired policy', async () => {
    await admin.setEnabled({ sourceKey: MANUAL_KEY, enabled: true });
    await database.db.query(
      `UPDATE site_policies SET review_expires_at = now() - interval '1 day'
        WHERE domain = 'myjobscotland.gov.uk'`,
    );
    const result = await admin.setEnabled({ sourceKey: MANUAL_KEY, enabled: false });
    expect(result.source.enabled).toBe(false);
  });

  it('refuses to store a new source that arrives already switched on but not permitted', async () => {
    await database.db.query(
      `UPDATE site_policies SET review_expires_at = now() - interval '1 day'
        WHERE domain = 'myjobscotland.gov.uk'`,
    );
    await expect(
      admin.upsertDefinition(manualDefinition({ key: 'another_manual', enabled: true })),
    ).rejects.toMatchObject({ reason: 'site_policy_expired' });
    expect(await stores.sources.getByKey('another_manual')).toBeNull();
  });
});

describe('scheduler readiness', () => {
  let database: { db: PGliteDatabase; close: () => Promise<void> };
  let stores: TrackingStores;
  let userId: string;

  const readinessFor = (id: string, facts: KnowledgeFact<unknown>[]) =>
    new SchedulerReadinessService({
      stores,
      userId: id,
      sitePolicyFor: (domain) => new SqlSitePolicyStore(database.db).findByDomain(domain),
      loadFacts: () => Promise.resolve(facts),
    });

  beforeEach(async () => {
    database = await createMigratedTestDatabase();
    stores = createTrackingStores(database.db);
    userId = uuidv7();
    await database.db.query(
      `INSERT INTO users (id, timezone, status) VALUES ($1, 'Europe/London', 'active')`,
      [userId],
    );
    await stores.sources.upsertDefinition(manualDefinition(), new Date('2026-09-25T09:00:00.000Z'));
  });

  afterEach(async () => {
    await database.close();
  });

  it('refuses to run with a malformed AGENT_USER_ID', async () => {
    const readiness = await readinessFor('not-a-profile-id', completeProfile()).check();
    expect(readiness.ready).toBe(false);
    expect(readiness.problems[0]?.code).toBe('agent_user_id_invalid');
  });

  it('refuses to run when no profile exists with that id', async () => {
    const readiness = await readinessFor(uuidv7(), completeProfile()).check();
    expect(readiness.ready).toBe(false);
    expect(readiness.problems[0]?.code).toBe('agent_user_not_found');
  });

  it('refuses to run while the profile is incomplete', async () => {
    const readiness = await readinessFor(userId, []).check();
    expect(readiness.ready).toBe(false);
    expect(readiness.problems.map((problem) => problem.code)).toContain('profile_incomplete');
  });

  it('refuses to run when no source is switched on', async () => {
    const readiness = await readinessFor(userId, completeProfile()).check();
    expect(readiness.problems.map((problem) => problem.code)).toContain('no_enabled_source');
  });

  it('reports a source that was switched on before its site policy expired', async () => {
    await stores.sources.setEnabled(MANUAL_KEY, true, null);
    await database.db.query(
      `UPDATE site_policies SET review_expires_at = now() - interval '1 day'
        WHERE domain = 'myjobscotland.gov.uk'`,
    );
    const readiness = await readinessFor(userId, completeProfile()).check();
    expect(readiness.ready).toBe(false);
    expect(readiness.problems.map((problem) => problem.code)).toContain(
      `source_invalid:${MANUAL_KEY}`,
    );
    expect(readiness.problems[0]?.message).toContain('ran out on');
  });

  it('is ready once the profile, source and site policy are all in order', async () => {
    await stores.sources.setEnabled(MANUAL_KEY, true, null);
    const service = readinessFor(userId, completeProfile());
    const readiness = await service.check(new Date('2026-09-25T10:00:00.000Z'));
    expect(readiness).toMatchObject({ ready: true, problems: [], enabledSources: 1 });
    const repeated = await service.check(new Date('2026-09-25T10:15:00.000Z'));
    expect(repeated.ready).toBe(true);
  });
});
