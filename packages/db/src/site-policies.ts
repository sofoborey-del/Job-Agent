import type { SitePolicy } from '@job-agent/policy';
import { attachmentReadPolicySchema, sitePolicySchema } from '@job-agent/policy';

import {
  asNullableText,
  asNumber,
  asRecord,
  asText,
  firstRow,
  iso,
  type SqlDatabase,
  type SqlRow,
} from './sql.js';

function mapPolicy(row: SqlRow): SitePolicy | null {
  const rateLimit = asRecord(row.rate_limit_json);
  const candidate: Record<string, unknown> = {
    domain: asText(row.domain),
    discoveryMode: asText(row.discovery_mode),
    applyMode: asText(row.apply_mode),
    termsStatus: asText(row.terms_status),
    evidenceUrl: asText(row.evidence_url),
    reviewedAt: iso(row.reviewed_at, new Date().toISOString()),
    reviewExpiresAt: iso(row.review_expires_at, new Date().toISOString()),
    autoSubmitAllowed: row.auto_submit_allowed === true,
    version: asNumber(row.version, 1),
  };
  const adapterId = asNullableText(row.adapter_id);
  if (adapterId !== null) candidate.adapterId = adapterId;
  const notes = asNullableText(row.notes);
  if (notes !== null) candidate.notes = notes;
  if (typeof rateLimit.requests === 'number' && typeof rateLimit.windowSeconds === 'number') {
    candidate.rateLimit = { requests: rateLimit.requests, windowSeconds: rateLimit.windowSeconds };
  }
  // A malformed attachment permission is dropped rather than repaired, so the policy falls back to
  // reading no attachments at all.
  if (row.attachment_read_json !== null && row.attachment_read_json !== undefined) {
    const attachment = attachmentReadPolicySchema.safeParse(asRecord(row.attachment_read_json));
    if (attachment.success) candidate.attachmentRead = attachment.data;
  }
  const parsed = sitePolicySchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

/**
 * Reads the reviewed site-policy record for a domain. A missing or malformed record returns null,
 * which every caller treats as "not permitted".
 */
export class SqlSitePolicyStore {
  constructor(private readonly db: SqlDatabase) {}

  async findByDomain(domain: string): Promise<SitePolicy | null> {
    const result = await this.db.query(
      `SELECT domain, adapter_id, discovery_mode, apply_mode, terms_status, evidence_url,
              reviewed_at, review_expires_at, auto_submit_allowed, rate_limit_json,
              attachment_read_json, notes, version
         FROM site_policies
        WHERE lower(domain) = lower($1)
        ORDER BY version DESC
        LIMIT 1`,
      [domain],
    );
    const row = firstRow(result);
    return row === null ? null : mapPolicy(row);
  }

  async list(): Promise<SitePolicy[]> {
    const result = await this.db.query(
      `SELECT DISTINCT ON (domain) domain, adapter_id, discovery_mode, apply_mode, terms_status,
              evidence_url, reviewed_at, review_expires_at, auto_submit_allowed, rate_limit_json,
              attachment_read_json, notes, version
         FROM site_policies
        ORDER BY domain, version DESC`,
    );
    return result.rows.map(mapPolicy).filter((policy): policy is SitePolicy => policy !== null);
  }
}
