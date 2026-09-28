import { sourceDefinitionSchema } from '@job-agent/discovery';
import { DiscoveryService, JobMatchService, SourceAdminService, type TrackingStores } from '@job-agent/tracking';
import { v7 as uuidv7 } from 'uuid';
import { expect, it } from 'vitest';

import { SqlSitePolicyStore } from './site-policies.js';
import { createTrackingStores } from './stores.js';
import { createMigratedTestDatabase } from './testing.js';

it('ingests Adzuna API results as incomplete leads without visiting employer sites or duplicating jobs', async () => {
  const database = await createMigratedTestDatabase();
  try {
    const stores: TrackingStores = createTrackingStores(database.db);
    const userId = uuidv7();
    const now = new Date();
    await database.db.query(
      `INSERT INTO users (id, timezone, status) VALUES ($1, 'Europe/London', 'active')`,
      [userId],
    );
    await stores.sources.upsertDefinition(
      sourceDefinitionSchema.parse({
        key: 'adzuna_gb_search',
        displayName: 'Adzuna UK job search',
        adapterType: 'public_api',
        sitePolicyDomain: 'api.adzuna.com',
        feedUrl: 'https://api.adzuna.com/v1/api/jobs/gb/search/1',
        enabled: false,
        reviewedBy: 'tests',
        reviewedAt: now.toISOString(),
      }),
      now,
    );
    const lookup = (domain: string) => new SqlSitePolicyStore(database.db).findByDomain(domain);
    const administration = new SourceAdminService({ stores, sitePolicyFor: lookup });
    const activation = await administration.setEnabled({ sourceKey: 'adzuna_gb_search', enabled: true, now });
    expect(activation.source.enabled).toBe(true);

    const requested: string[] = [];
    const fetcher = ((input: string | URL) => {
      const url = new URL(input.toString());
      requested.push(url.hostname);
      if (url.hostname !== 'api.adzuna.com') throw new Error('Unexpected off-host fetch');
      return Promise.resolve(new Response(
        JSON.stringify({
          count: 1,
          results: [{
            id: '12345',
            title: 'Customer Service Advisor',
            description: 'A short excerpt only.',
            redirect_url: 'https://example-employer.invalid/jobs/12345',
            salary_min: 27000,
            company: { display_name: 'Example Employer' },
            location: { display_name: 'Glasgow' },
          }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ));
    }) as typeof fetch;
    const service = new DiscoveryService({
      stores,
      userId,
      sitePolicyFor: lookup,
      adzunaCredentials: { appId: 'test-id', appKey: 'test-key' },
      fetcher,
      sleep: () => Promise.resolve(),
    });
    const first = await service.runSource({ sourceKey: 'adzuna_gb_search', trigger: 'manual', now });
    expect(first.status).toBe('succeeded');
    expect(first.counts.created).toBe(1);
    expect(requested).toEqual(['api.adzuna.com']);

    const rows = await database.db.query<{
      description_completeness: string;
      person_spec_status: string;
    }>('SELECT description_completeness, person_spec_status FROM jobs');
    expect(rows.rows).toEqual([{
      description_completeness: 'snippet',
      person_spec_status: 'unreadable',
    }]);

    const matched = await new JobMatchService({ stores, userId }).matchAwaiting({ facts: [], now });
    expect(matched.evaluated).toBe(1);
    expect(matched.notified).toBe(0);
    const tracking = await database.db.query<{ review_status: string }>(
      'SELECT review_status FROM job_tracking WHERE user_id = $1',
      [userId],
    );
    expect(tracking.rows[0]?.review_status).toBe('discovered');

    const replay = await service.runSource({ sourceKey: 'adzuna_gb_search', trigger: 'manual', now });
    expect(replay.status).toBe('already_ran');
    expect(requested).toEqual(['api.adzuna.com']);
  } finally {
    await database.close();
  }
});
