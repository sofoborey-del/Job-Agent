import { describe, expect, it } from 'vitest';

import {
  discoveryPermitted,
  evaluateSitePolicy,
  hostWithinPolicy,
  PolicyRateLimiter,
  sitePolicySchema,
  type SitePolicy,
} from './index.js';

const basePolicy: SitePolicy = sitePolicySchema.parse({
  domain: 'myjobscotland.gov.uk',
  discoveryMode: 'manual_url',
  applyMode: 'prefill_only',
  termsStatus: 'permission_required',
  evidenceUrl: 'https://myjobscotland.gov.uk/disclaimer',
  reviewedAt: '2026-01-01T00:00:00.000Z',
  reviewExpiresAt: '2027-01-01T00:00:00.000Z',
  autoSubmitAllowed: false,
  rateLimit: { requests: 2, windowSeconds: 60 },
  version: 1,
});

describe('site policy evaluation', () => {
  it('fails closed once the review has expired', () => {
    const evaluation = evaluateSitePolicy(basePolicy, new Date('2027-02-01T00:00:00.000Z'));
    expect(evaluation.decision).toBe('expired');
    expect(
      discoveryPermitted(basePolicy, 'manual_url', new Date('2027-02-01T00:00:00.000Z')),
    ).toEqual({
      allowed: false,
      reason: 'site_policy_expired',
    });
  });

  it('refuses everything when the terms prohibit automation', () => {
    const prohibited = { ...basePolicy, termsStatus: 'reviewed_prohibited' as const };
    expect(evaluateSitePolicy(prohibited).decision).toBe('disabled');
    expect(discoveryPermitted(prohibited, 'manual_url').allowed).toBe(false);
  });

  it('treats an unreviewed domain as unknown rather than allowed', () => {
    const unknown = { ...basePolicy, termsStatus: 'unknown' as const };
    expect(evaluateSitePolicy(unknown).decision).toBe('unknown');
    expect(discoveryPermitted(unknown, 'feed').allowed).toBe(false);
  });

  it('does not allow feed polling unless the reviewed policy says feed or API', () => {
    expect(discoveryPermitted(basePolicy, 'feed')).toEqual({
      allowed: false,
      reason: 'feed_discovery_not_reviewed',
    });
    expect(discoveryPermitted({ ...basePolicy, discoveryMode: 'feed' }, 'feed').allowed).toBe(true);
  });

  it('never returns auto_submit_allowed without reviewed_allowed terms', () => {
    const wanted = { ...basePolicy, applyMode: 'auto_submit' as const, autoSubmitAllowed: true };
    expect(evaluateSitePolicy(wanted).decision).toBe('prefill_only');
    expect(evaluateSitePolicy({ ...wanted, termsStatus: 'reviewed_allowed' }).decision).toBe(
      'auto_submit_allowed',
    );
  });
});

describe('host scoping', () => {
  it('accepts the reviewed domain and its subdomains over HTTPS only', () => {
    expect(hostWithinPolicy('https://myjobscotland.gov.uk/jobs/1', basePolicy)).toBe(true);
    expect(hostWithinPolicy('https://www.myjobscotland.gov.uk/jobs/1', basePolicy)).toBe(true);
    expect(hostWithinPolicy('http://myjobscotland.gov.uk/jobs/1', basePolicy)).toBe(false);
    expect(hostWithinPolicy('https://myjobscotland.gov.uk.evil.test/jobs/1', basePolicy)).toBe(
      false,
    );
    expect(hostWithinPolicy('not a url', basePolicy)).toBe(false);
  });
});

describe('rate limiting', () => {
  it('spaces requests according to the reviewed limit', () => {
    const limiter = new PolicyRateLimiter(basePolicy);
    const start = 1_000_000;
    expect(limiter.delayFor(start)).toBe(0);
    limiter.record(start);
    limiter.record(start);
    expect(limiter.delayFor(start)).toBe(60_000);
    expect(limiter.delayFor(start + 60_000)).toBe(0);
  });
});
