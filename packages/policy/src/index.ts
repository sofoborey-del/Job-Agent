import type { SitePolicyDecision } from '@job-agent/domain';
import { z } from 'zod';

export const discoveryModes = [
  'official_api',
  'feed',
  'manual_url',
  'browser_allowed',
  'disabled',
] as const;

export const applyModes = ['official_api', 'manual_only', 'prefill_only', 'auto_submit'] as const;

export const termsStatuses = [
  'reviewed_allowed',
  'reviewed_prohibited',
  'permission_required',
  'unknown',
] as const;

export const attachmentContentTypes = [
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
] as const;

/**
 * Reading a document an advert links to is an extra request to the site, so it is opt-in per
 * reviewed policy in the same way a feed address is. A policy without this block reads no
 * attachments at all.
 */
export const attachmentReadPolicySchema = z.object({
  allowed: z.boolean(),
  contentTypes: z.array(z.enum(attachmentContentTypes)).min(1),
  maxBytes: z
    .number()
    .int()
    .positive()
    .max(20 * 1024 * 1024),
  maxPerAdvert: z.number().int().positive().max(10),
  /** Optional extra narrowing. When present, an attachment path must start with one of these. */
  pathPrefixes: z.array(z.string().startsWith('/')).optional(),
});

export type AttachmentReadPolicy = z.infer<typeof attachmentReadPolicySchema>;

export const sitePolicySchema = z.object({
  domain: z
    .string()
    .min(3)
    .regex(/^[a-z0-9.-]+$/, 'Domain must be a lowercase hostname'),
  adapterId: z.string().min(1).optional(),
  discoveryMode: z.enum(discoveryModes),
  applyMode: z.enum(applyModes),
  termsStatus: z.enum(termsStatuses),
  evidenceUrl: z.url().startsWith('https://'),
  reviewedAt: z.iso.datetime({ offset: true }),
  reviewExpiresAt: z.iso.datetime({ offset: true }),
  autoSubmitAllowed: z.boolean(),
  rateLimit: z
    .object({
      requests: z.number().int().positive().max(600),
      windowSeconds: z.number().int().positive().max(86_400),
    })
    .optional(),
  adapterVersion: z.string().min(1).optional(),
  attachmentRead: attachmentReadPolicySchema.optional(),
  notes: z.string().max(2000).optional(),
  version: z.number().int().positive(),
});

export type SitePolicy = z.infer<typeof sitePolicySchema>;

export type DiscoveryAction = 'official_api' | 'feed' | 'manual_url';

export type PolicyEvaluation = {
  decision: SitePolicyDecision;
  reasons: string[];
};

/** Unknown, expired or prohibited policies fail closed. */
export function evaluateSitePolicy(policy: SitePolicy, now = new Date()): PolicyEvaluation {
  const reasons: string[] = [];
  if (new Date(policy.reviewExpiresAt).getTime() <= now.getTime()) {
    return { decision: 'expired', reasons: ['site_policy_review_expired'] };
  }
  if (policy.termsStatus === 'reviewed_prohibited') {
    return { decision: 'disabled', reasons: ['terms_prohibit_automation'] };
  }
  if (policy.discoveryMode === 'disabled') {
    return { decision: 'disabled', reasons: ['discovery_disabled'] };
  }
  if (policy.termsStatus === 'unknown') {
    return { decision: 'unknown', reasons: ['terms_not_reviewed'] };
  }
  if (policy.applyMode === 'auto_submit' && policy.autoSubmitAllowed) {
    if (policy.termsStatus !== 'reviewed_allowed') {
      reasons.push('auto_submit_requires_reviewed_allowed');
      return { decision: 'prefill_only', reasons };
    }
    return { decision: 'auto_submit_allowed', reasons };
  }
  if (policy.applyMode === 'prefill_only') return { decision: 'prefill_only', reasons };
  return { decision: 'manual_only', reasons };
}

export type PermissionResult = { allowed: true } | { allowed: false; reason: string };

/**
 * Read-only discovery permission. A feed may only be polled when the reviewed policy says so,
 * which is what stops the agent guessing at an undocumented endpoint.
 */
export function discoveryPermitted(
  policy: SitePolicy,
  action: DiscoveryAction,
  now = new Date(),
): PermissionResult {
  const evaluation = evaluateSitePolicy(policy, now);
  if (evaluation.decision === 'expired') return { allowed: false, reason: 'site_policy_expired' };
  if (evaluation.decision === 'disabled') return { allowed: false, reason: 'site_policy_disabled' };
  if (evaluation.decision === 'unknown') return { allowed: false, reason: 'site_policy_unknown' };
  if (action === 'manual_url') {
    return policy.discoveryMode === 'disabled'
      ? { allowed: false, reason: 'discovery_disabled' }
      : { allowed: true };
  }
  if (action === 'feed') {
    return policy.discoveryMode === 'feed' || policy.discoveryMode === 'official_api'
      ? { allowed: true }
      : { allowed: false, reason: 'feed_discovery_not_reviewed' };
  }
  return policy.discoveryMode === 'official_api'
    ? { allowed: true }
    : { allowed: false, reason: 'api_discovery_not_reviewed' };
}

/**
 * Permission to read one document linked from a public advert.
 *
 * This is deliberately narrower than a page read. Every one of these must hold, and anything
 * missing or unreviewed is a refusal rather than a default:
 *
 * - the reviewed policy is current, not disabled and its terms have been looked at;
 * - the policy carries an explicit `attachmentRead` block that says `allowed`;
 * - the URL is HTTPS and on the reviewed domain (or a subdomain of it);
 * - the URL's path is inside `pathPrefixes` when the reviewed policy narrows them.
 *
 * The caller is separately responsible for only passing a URL that the advert page itself
 * published. Nothing here authorises a constructed or guessed address.
 */
export function attachmentReadPermitted(
  policy: SitePolicy,
  rawUrl: string,
  now = new Date(),
): PermissionResult {
  const evaluation = evaluateSitePolicy(policy, now);
  if (evaluation.decision === 'expired') return { allowed: false, reason: 'site_policy_expired' };
  if (evaluation.decision === 'disabled') return { allowed: false, reason: 'site_policy_disabled' };
  if (evaluation.decision === 'unknown') return { allowed: false, reason: 'site_policy_unknown' };
  if (policy.discoveryMode === 'disabled') return { allowed: false, reason: 'discovery_disabled' };

  const attachment = policy.attachmentRead;
  if (attachment === undefined) {
    return { allowed: false, reason: 'attachment_read_not_reviewed' };
  }
  if (!attachment.allowed) {
    return { allowed: false, reason: 'attachment_read_not_permitted' };
  }

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { allowed: false, reason: 'attachment_url_invalid' };
  }
  if (url.protocol !== 'https:') return { allowed: false, reason: 'attachment_not_https' };
  if (!hostWithinPolicy(rawUrl, policy)) {
    return { allowed: false, reason: 'attachment_host_outside_policy' };
  }
  const prefixes = attachment.pathPrefixes;
  if (prefixes !== undefined && !prefixes.some((prefix) => url.pathname.startsWith(prefix))) {
    return { allowed: false, reason: 'attachment_path_not_reviewed' };
  }
  return { allowed: true };
}

/** A URL is in scope only when its host is the reviewed domain or a subdomain of it. */
export function hostWithinPolicy(rawUrl: string, policy: SitePolicy): boolean {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:') return false;
  const host = url.hostname.toLowerCase();
  return host === policy.domain || host.endsWith(`.${policy.domain}`);
}

export function assertHostWithinPolicy(rawUrl: string, policy: SitePolicy): void {
  if (!hostWithinPolicy(rawUrl, policy)) {
    throw new Error('URL is outside the reviewed site policy');
  }
}

/** Simple request spacing that honours the reviewed rate limit. */
export class PolicyRateLimiter {
  private readonly timestamps: number[] = [];

  constructor(private readonly policy: SitePolicy) {}

  /** Returns the number of milliseconds the caller must wait before the next request. */
  delayFor(now = Date.now()): number {
    const limit = this.policy.rateLimit;
    if (limit === undefined) return 0;
    const windowMs = limit.windowSeconds * 1000;
    while (this.timestamps.length > 0 && (this.timestamps[0] ?? 0) <= now - windowMs) {
      this.timestamps.shift();
    }
    if (this.timestamps.length < limit.requests) return 0;
    const oldest = this.timestamps[0] ?? now;
    return Math.max(0, oldest + windowMs - now);
  }

  record(now = Date.now()): void {
    this.timestamps.push(now);
  }
}
