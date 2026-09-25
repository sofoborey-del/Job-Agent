import { describe, expect, it } from 'vitest';

import { attachmentReadPermitted, sitePolicySchema, type SitePolicy } from './index.js';

const withoutAttachmentPermission: SitePolicy = sitePolicySchema.parse({
  domain: 'myjobscotland.gov.uk',
  discoveryMode: 'manual_url',
  applyMode: 'prefill_only',
  termsStatus: 'permission_required',
  evidenceUrl: 'https://myjobscotland.gov.uk/disclaimer',
  reviewedAt: '2026-01-01T00:00:00.000Z',
  reviewExpiresAt: '2027-01-01T00:00:00.000Z',
  autoSubmitAllowed: false,
  rateLimit: { requests: 10, windowSeconds: 60 },
  version: 1,
});

const permitted: SitePolicy = sitePolicySchema.parse({
  ...withoutAttachmentPermission,
  attachmentRead: {
    allowed: true,
    contentTypes: ['application/pdf'],
    maxBytes: 10_485_760,
    maxPerAdvert: 3,
  },
  version: 2,
});

const advertDocument = 'https://myjobscotland.gov.uk/media/person-spec.pdf';
const now = new Date('2026-06-01T00:00:00.000Z');

describe('permission to read a document an advert links', () => {
  it('refuses when the reviewed policy says nothing about attachments', () => {
    expect(attachmentReadPermitted(withoutAttachmentPermission, advertDocument, now)).toEqual({
      allowed: false,
      reason: 'attachment_read_not_reviewed',
    });
  });

  it('refuses when the reviewed policy switches attachment reading off', () => {
    const off = sitePolicySchema.parse({
      ...permitted,
      attachmentRead: { ...permitted.attachmentRead, allowed: false },
    });
    expect(attachmentReadPermitted(off, advertDocument, now)).toEqual({
      allowed: false,
      reason: 'attachment_read_not_permitted',
    });
  });

  it('allows a document on the reviewed domain once the permission exists', () => {
    expect(attachmentReadPermitted(permitted, advertDocument, now)).toEqual({ allowed: true });
  });

  it('allows a subdomain of the reviewed domain', () => {
    expect(
      attachmentReadPermitted(permitted, 'https://www.myjobscotland.gov.uk/d/spec.pdf', now),
    ).toEqual({ allowed: true });
  });

  it('refuses a document on any other host', () => {
    expect(attachmentReadPermitted(permitted, 'https://example.com/spec.pdf', now)).toEqual({
      allowed: false,
      reason: 'attachment_host_outside_policy',
    });
  });

  it('refuses a host that merely ends with the reviewed domain as a suffix', () => {
    expect(
      attachmentReadPermitted(permitted, 'https://notmyjobscotland.gov.uk/spec.pdf', now),
    ).toEqual({ allowed: false, reason: 'attachment_host_outside_policy' });
  });

  it('refuses plain HTTP', () => {
    expect(attachmentReadPermitted(permitted, 'http://myjobscotland.gov.uk/spec.pdf', now)).toEqual(
      { allowed: false, reason: 'attachment_not_https' },
    );
  });

  it('refuses once the review has expired', () => {
    expect(
      attachmentReadPermitted(permitted, advertDocument, new Date('2027-02-01T00:00:00.000Z')),
    ).toEqual({ allowed: false, reason: 'site_policy_expired' });
  });

  it('refuses when the reviewed terms prohibit automation', () => {
    const prohibited = { ...permitted, termsStatus: 'reviewed_prohibited' as const };
    expect(attachmentReadPermitted(prohibited, advertDocument, now)).toEqual({
      allowed: false,
      reason: 'site_policy_disabled',
    });
  });

  it('refuses when the terms have never been reviewed', () => {
    const unknown = { ...permitted, termsStatus: 'unknown' as const };
    expect(attachmentReadPermitted(unknown, advertDocument, now)).toEqual({
      allowed: false,
      reason: 'site_policy_unknown',
    });
  });

  it('refuses a path outside the reviewed prefixes when the policy narrows them', () => {
    const narrowed = sitePolicySchema.parse({
      ...permitted,
      attachmentRead: { ...permitted.attachmentRead, pathPrefixes: ['/media/'] },
    });
    expect(attachmentReadPermitted(narrowed, advertDocument, now)).toEqual({ allowed: true });
    expect(
      attachmentReadPermitted(narrowed, 'https://myjobscotland.gov.uk/other/spec.pdf', now),
    ).toEqual({ allowed: false, reason: 'attachment_path_not_reviewed' });
  });

  it('refuses a malformed address', () => {
    expect(attachmentReadPermitted(permitted, 'not-a-url', now)).toEqual({
      allowed: false,
      reason: 'attachment_url_invalid',
    });
  });
});
