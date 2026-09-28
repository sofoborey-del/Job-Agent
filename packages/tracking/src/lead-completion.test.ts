import { describe, expect, it, vi } from 'vitest';

import type { SitePolicy } from '@job-agent/policy';

import { candidateDomains, checkOfficialUrl } from './lead-completion.js';

/** A current, reviewed policy of the kind MyJobScotland has. */
function policy(overrides: Partial<SitePolicy> = {}): SitePolicy {
  return {
    domain: 'myjobscotland.gov.uk',
    adapterId: 'myjobscotland',
    discoveryMode: 'manual_url',
    applyMode: 'prefill_only',
    termsStatus: 'permission_required',
    evidenceUrl: 'https://myjobscotland.gov.uk/disclaimer',
    reviewedAt: '2026-09-01T00:00:00.000Z',
    reviewExpiresAt: '2027-09-01T00:00:00.000Z',
    autoSubmitAllowed: false,
    rateLimit: { requests: 10, windowSeconds: 60 },
    ...overrides,
  } as SitePolicy;
}

/** Answers for one domain only; every other lookup returns null, as an unreviewed site would. */
function lookupFor(domain: string, value: SitePolicy | null = policy()) {
  return vi.fn((candidate: string) => Promise.resolve(candidate === domain ? value : null));
}

describe('which domains a policy can cover', () => {
  it('walks up to the registrable parent but no further', () => {
    expect(candidateDomains('www.myjobscotland.gov.uk')).toEqual([
      'www.myjobscotland.gov.uk',
      'myjobscotland.gov.uk',
      'gov.uk',
    ]);
  });

  it('never produces a single label', () => {
    for (const domain of candidateDomains('a.b.c.example.com')) {
      expect(domain.split('.').length).toBeGreaterThanOrEqual(2);
    }
  });
});

describe('checking an address before anything is fetched', () => {
  it('allows a reviewed domain with a reader', async () => {
    const result = await checkOfficialUrl({
      url: 'https://www.myjobscotland.gov.uk/councils/glasgow-city-council/jobs/adviser-123',
      sitePolicyFor: lookupFor('myjobscotland.gov.uk'),
    });
    expect(result).toMatchObject({ allowed: true, domain: 'myjobscotland.gov.uk' });
  });

  /** The central guarantee: an unreviewed site is refused, not probed. */
  it('refuses an unreviewed domain without contacting it', async () => {
    const lookup = lookupFor('myjobscotland.gov.uk');
    const result = await checkOfficialUrl({
      url: 'https://www.s1jobs.com/job/customer-adviser-999',
      sitePolicyFor: lookup,
    });
    expect(result).toMatchObject({ allowed: false, reason: 'no_site_policy' });
    if (result.allowed) return;
    expect(result.message).toContain('has not been reviewed');
    // Every lookup was a local policy read; none of them is a request to the site.
    for (const call of lookup.mock.calls) expect(call[0]).not.toContain('://');
  });

  it.each([
    'https://www.indeed.co.uk/viewjob?jk=abc',
    'https://www.totaljobs.com/job/12345',
    'https://www.s1jobs.com/job/999',
    'https://www.linkedin.com/jobs/view/1',
  ])('refuses %s', async (url) => {
    const result = await checkOfficialUrl({
      url,
      sitePolicyFor: lookupFor('myjobscotland.gov.uk'),
    });
    expect(result.allowed).toBe(false);
  });

  it('refuses a lookalike domain that merely ends in the reviewed name', async () => {
    const result = await checkOfficialUrl({
      url: 'https://myjobscotland.gov.uk.phishing.example/job',
      sitePolicyFor: lookupFor('myjobscotland.gov.uk'),
    });
    expect(result.allowed).toBe(false);
  });

  it.each([
    ['http://www.myjobscotland.gov.uk/job/1', 'not_https'],
    ['ftp://myjobscotland.gov.uk/job/1', 'not_https'],
    ['not a url', 'not_https'],
    ['https://user:secret@myjobscotland.gov.uk/job/1', 'url_has_credentials'],
  ])('refuses %s with %s', async (url, reason) => {
    const result = await checkOfficialUrl({
      url,
      sitePolicyFor: lookupFor('myjobscotland.gov.uk'),
    });
    expect(result).toMatchObject({ allowed: false, reason });
  });

  it('refuses when the policy exists but forbids discovery', async () => {
    const result = await checkOfficialUrl({
      url: 'https://www.myjobscotland.gov.uk/job/1',
      sitePolicyFor: lookupFor(
        'myjobscotland.gov.uk',
        policy({ termsStatus: 'reviewed_prohibited' }),
      ),
    });
    expect(result).toMatchObject({ allowed: false, reason: 'policy_forbids_discovery' });
  });

  it('refuses when the policy review has expired', async () => {
    const result = await checkOfficialUrl({
      url: 'https://www.myjobscotland.gov.uk/job/1',
      sitePolicyFor: lookupFor(
        'myjobscotland.gov.uk',
        policy({ reviewExpiresAt: '2020-01-01T00:00:00.000Z' }),
      ),
    });
    expect(result).toMatchObject({ allowed: false, reason: 'policy_forbids_discovery' });
  });

  it('refuses when a policy exists but no reader was written for that domain', async () => {
    const result = await checkOfficialUrl({
      url: 'https://api.adzuna.com/v1/api/jobs/gb/search/1',
      sitePolicyFor: lookupFor(
        'api.adzuna.com',
        policy({
          domain: 'api.adzuna.com',
          discoveryMode: 'official_api',
          termsStatus: 'reviewed_allowed',
        }),
      ),
    });
    expect(result).toMatchObject({ allowed: false, reason: 'no_reviewed_reader' });
  });
});
