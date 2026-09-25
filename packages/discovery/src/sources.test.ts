import { describe, expect, it } from 'vitest';

import { parseJobFeed } from './feed.js';
import { normaliseDiscoveredJob } from './normalise.js';
import type { DiscoveredJob } from './myjobscotland.js';
import {
  defaultSourceDefinitions,
  MINIMUM_SCHEDULE_INTERVAL_SECONDS,
  sourceDefinitionSchema,
  supportedDiscoveryDomains,
} from './sources.js';

const policy = {
  domain: 'myjobscotland.gov.uk',
  discoveryMode: 'feed' as const,
  applyMode: 'prefill_only' as const,
  termsStatus: 'permission_required' as const,
  evidenceUrl: 'https://myjobscotland.gov.uk/disclaimer',
  reviewedAt: '2026-01-01T00:00:00.000Z',
  reviewExpiresAt: '2027-01-01T00:00:00.000Z',
  autoSubmitAllowed: false,
  version: 1,
};

const discovered: DiscoveredJob = {
  source: 'myjobscotland',
  externalId: '12345',
  canonicalUrl: 'https://www.myjobscotland.gov.uk/councils/example/jobs/officer-12345?utm_source=x',
  title: '  Compliance   Officer ',
  employer: 'Example Council',
  location: ' Glasgow ',
  description: 'You must hold a relevant qualification.\nExperience is essential.',
  salary: {
    minimumMinor: 3_200_000,
    maximumMinor: 3_600_000,
    currency: 'GBP',
    basis: 'annual_base',
    confidence: 0.99,
    sourceText: '£32,000 - £36,000',
  },
  employmentTypes: ['FULL_TIME'],
  contractType: 'Permanent',
  hours: '35',
  workPattern: null,
  publishedAt: '2026-09-01T00:00:00.000Z',
  closesAt: '2026-10-01T00:00:00.000Z',
  contentHash: 'unused',
};

describe('source definitions', () => {
  it('ships nothing enabled by default', () => {
    expect(defaultSourceDefinitions.every((source) => !source.enabled)).toBe(true);
  });

  it('refuses a feed source with no explicitly configured feed URL', () => {
    const result = sourceDefinitionSchema.safeParse({
      key: 'example_feed',
      displayName: 'Example feed',
      adapterType: 'public_feed',
      sitePolicyDomain: 'myjobscotland.gov.uk',
      reviewedBy: 'samuel',
      reviewedAt: '2026-09-01T00:00:00.000Z',
    });
    expect(result.success).toBe(false);
  });

  it('refuses a domain that has no reviewed public parser', () => {
    const result = sourceDefinitionSchema.safeParse({
      key: 'somewhere_else',
      displayName: 'Somewhere else',
      adapterType: 'manual_url_list',
      sitePolicyDomain: 'example.com',
      manualUrls: ['https://example.com/jobs/1'],
      reviewedBy: 'samuel',
      reviewedAt: '2026-09-01T00:00:00.000Z',
    });
    expect(result.success).toBe(false);
    expect(supportedDiscoveryDomains()).toEqual(['myjobscotland.gov.uk']);
  });

  it('refuses a polling interval below the floor', () => {
    const result = sourceDefinitionSchema.safeParse({
      key: 'too_fast',
      displayName: 'Too fast',
      adapterType: 'manual_url_list',
      sitePolicyDomain: 'myjobscotland.gov.uk',
      manualUrls: ['https://myjobscotland.gov.uk/jobs/1'],
      scheduleIntervalSeconds: MINIMUM_SCHEDULE_INTERVAL_SECONDS - 1,
      reviewedBy: 'samuel',
      reviewedAt: '2026-09-01T00:00:00.000Z',
    });
    expect(result.success).toBe(false);
  });
});

describe('feed parsing', () => {
  it('reads RSS items and drops links outside the reviewed domain', () => {
    const items = parseJobFeed(
      `<rss><channel>
         <item><title>Officer</title><link>https://myjobscotland.gov.uk/jobs/1</link><guid>1</guid><pubDate>Mon, 01 Sep 2026 09:00:00 GMT</pubDate></item>
         <item><title>Elsewhere</title><link>https://elsewhere.example.com/jobs/2</link><guid>2</guid></item>
         <item><title>Repeat</title><link>https://myjobscotland.gov.uk/jobs/1</link><guid>1</guid></item>
       </channel></rss>`,
      policy,
    );
    expect(items).toHaveLength(1);
    expect(items[0]?.url).toBe('https://myjobscotland.gov.uk/jobs/1');
    expect(items[0]?.publishedAt).toBe('2026-09-01T09:00:00.000Z');
  });

  it('reads Atom entries using the alternate link', () => {
    const items = parseJobFeed(
      `<feed><entry><title>Officer</title><id>abc</id>
         <link rel="alternate" href="https://www.myjobscotland.gov.uk/jobs/9"/>
       </entry></feed>`,
      policy,
    );
    expect(items[0]?.url).toBe('https://www.myjobscotland.gov.uk/jobs/9');
  });
});

describe('normalisation', () => {
  it('produces the same content hash for the same advert fetched twice', () => {
    const first = normaliseDiscoveredJob('myjobscotland_manual', discovered);
    const second = normaliseDiscoveredJob('myjobscotland_manual', {
      ...discovered,
      title: 'Compliance Officer',
      location: 'Glasgow',
      contentHash: 'something-else',
    });
    expect(first.contentHash).toBe(second.contentHash);
    expect(first.canonicalUrl).toBe(
      'https://www.myjobscotland.gov.uk/councils/example/jobs/officer-12345',
    );
  });

  it('changes the content hash when the advert text changes', () => {
    const changed = normaliseDiscoveredJob('myjobscotland_manual', {
      ...discovered,
      description: 'You must hold a relevant qualification. Now also SC clearance is essential.',
    });
    expect(changed.contentHash).not.toBe(
      normaliseDiscoveredJob('myjobscotland_manual', discovered).contentHash,
    );
  });

  it('gives the same duplicate fingerprint to the same role advertised at another URL', () => {
    const first = normaliseDiscoveredJob('a', discovered);
    const second = normaliseDiscoveredJob('b', {
      ...discovered,
      externalId: '99999',
      canonicalUrl: 'https://myjobscotland.gov.uk/councils/other/jobs/officer-99999',
    });
    expect(first.fingerprint).toBe(second.fingerprint);
    expect(first.canonicalUrl).not.toBe(second.canonicalUrl);
  });
});
