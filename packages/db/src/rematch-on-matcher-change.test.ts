import { sourceDefinitionSchema } from '@job-agent/discovery';
import {
  DiscoveryService,
  JobMatchService,
  SourceAdminService,
  type TrackingStores,
} from '@job-agent/tracking';
import { v7 as uuidv7 } from 'uuid';
import { expect, it } from 'vitest';

import { SqlSitePolicyStore } from './site-policies.js';
import { createTrackingStores } from './stores.js';
import { createMigratedTestDatabase } from './testing.js';

/**
 * A changed matcher must re-score jobs it has already scored.
 *
 * Selection used to depend only on the needs_rematch flag, which ingestion sets when an advert's
 * content changes and nothing sets when the matcher changes. The consequence was silent: a new
 * matcher version shipped, every stored decision kept the old matcher's answer, and the tracker
 * showed scores no current code would produce. Ten real adverts sat on a superseded matcher for
 * three days that way.
 */
it('re-scores a job when the matcher version changes, and not otherwise', async () => {
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
    await new SourceAdminService({ stores, sitePolicyFor: lookup }).setEnabled({
      sourceKey: 'adzuna_gb_search',
      enabled: true,
      now,
    });

    const fetcher = (() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            count: 1,
            results: [
              {
                id: '12345',
                title: 'Customer Service Advisor',
                description: 'A short excerpt only.',
                redirect_url: 'https://example-employer.invalid/jobs/12345',
                salary_min: 27000,
                company: { display_name: 'Example Employer' },
                location: { display_name: 'Glasgow' },
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      )) as typeof fetch;

    await new DiscoveryService({
      stores,
      userId,
      sitePolicyFor: lookup,
      adzunaCredentials: { appId: 'test-id', appKey: 'test-key' },
      fetcher,
      sleep: () => Promise.resolve(),
    }).runSource({ sourceKey: 'adzuna_gb_search', trigger: 'manual', now });

    const matching = new JobMatchService({ stores, userId });
    expect((await matching.matchAwaiting({ facts: [], now })).evaluated).toBe(1);

    // Read the version back from the stored run rather than importing it. This package does not
    // depend on the matcher, and the test should not be the thing that introduces that edge.
    const stored = await database.db.query<{ matcher_version: string }>(
      'SELECT matcher_version FROM match_runs WHERE user_id = $1',
      [userId],
    );
    const currentMatcher = stored.rows[0]?.matcher_version ?? '';
    expect(currentMatcher).not.toBe('');

    // Scored by the matcher that is running, and no longer flagged: nothing is due.
    expect(await stores.tracking.listAwaitingMatch(userId, 50, currentMatcher)).toHaveLength(0);
    expect((await matching.matchAwaiting({ facts: [], now })).evaluated).toBe(0);

    // A different matcher makes it due again, without anything touching the advert.
    const underNewMatcher = await stores.tracking.listAwaitingMatch(userId, 50, 'shadow-9.9.9');
    expect(underNewMatcher).toHaveLength(1);

    // Omitting the version keeps the old behaviour, so callers that do not track a matcher are
    // unaffected: only a flagged job is due.
    expect(await stores.tracking.listAwaitingMatch(userId, 50)).toHaveLength(0);
  } finally {
    await database.close();
  }
});
