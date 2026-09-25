import { describe, expect, it } from 'vitest';

import { canonicalizeJobUrl, createJobFingerprint, createSourceJobKey } from './index.js';

describe('job URL canonicalisation', () => {
  it('removes fragments and tracking while preserving meaningful job ids', () => {
    expect(
      canonicalizeJobUrl(
        'https://CAREERS.example.com/jobs/123/?utm_source=board&jobId=123&gh_jid=456#apply',
      ),
    ).toBe('https://careers.example.com/jobs/123?gh_jid=456&jobId=123');
  });

  it('rejects non-HTTPS URLs', () => {
    expect(() => canonicalizeJobUrl('http://example.com/jobs/1')).toThrow(
      'Only HTTPS job URLs are accepted',
    );
    expect(() => canonicalizeJobUrl('file:///etc/passwd')).toThrow(
      'Only HTTPS job URLs are accepted',
    );
  });
});

describe('job deduplication keys', () => {
  it('creates the same fingerprint despite whitespace, case, and tracking changes', () => {
    const first = createJobFingerprint({
      canonicalUrl: 'https://jobs.example.com/role/1?utm_campaign=test',
      employer: 'Example Ltd',
      title: 'Claims Handler',
      location: 'Glasgow',
    });
    const second = createJobFingerprint({
      canonicalUrl: 'https://JOBS.example.com/role/1',
      employer: '  EXAMPLE   LTD ',
      title: 'claims handler',
      location: 'glasgow',
    });
    expect(first).toBe(second);
    expect(first).toMatch(/^[a-f0-9]{64}$/);
  });

  it('keeps source identity explicit', () => {
    expect(createSourceJobKey({ sourceId: 'feed-1', externalId: 'job-10' })).toBe('feed-1:job-10');
  });
});
