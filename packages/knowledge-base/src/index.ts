import type { KnowledgeFact } from '@job-agent/domain';
import { z } from 'zod';

const isoTimestamp = z.iso.datetime({ offset: true });

export const knowledgeFactSchema = z.object({
  id: z.string().min(1),
  key: z
    .string()
    .min(1)
    .regex(/^[a-z][a-z0-9_.-]*$/),
  value: z.unknown().nullable(),
  status: z.enum(['verified', 'unverified', 'unknown', 'declined']),
  source: z.enum(['user', 'cv', 'document', 'derived']),
  sourceRef: z.string().min(1).optional(),
  verifiedAt: isoTimestamp.optional(),
  expiresAt: isoTimestamp.optional(),
  sensitivity: z.enum(['normal', 'personal', 'high_risk']),
  usePolicy: z.enum(['auto_fill', 'ask_each_time', 'never_auto_fill']),
  allowedPurposes: z
    .array(z.enum(['matching', 'application', 'reporting']))
    .min(1)
    .refine((purposes) => new Set(purposes).size === purposes.length, 'Purposes must be unique'),
  version: z.number().int().positive(),
});

export type KnowledgePurpose = 'matching' | 'application' | 'reporting';

export type FactResolution<T> =
  | { status: 'resolved'; factId: string; value: T }
  | { status: 'requires_user'; factId: string; reason: string }
  | { status: 'unavailable'; factId: string; reason: string };

function isExpired(fact: KnowledgeFact<unknown>, now: Date): boolean {
  return fact.expiresAt !== undefined && new Date(fact.expiresAt).getTime() <= now.getTime();
}

export function resolveFact<T>(
  fact: KnowledgeFact<T>,
  purpose: KnowledgePurpose,
  now = new Date(),
): FactResolution<T> {
  knowledgeFactSchema.parse(fact);

  if (!fact.allowedPurposes.includes(purpose)) {
    return { status: 'unavailable', factId: fact.id, reason: 'purpose_not_allowed' };
  }
  if (fact.status !== 'verified' || fact.value === null) {
    return { status: 'requires_user', factId: fact.id, reason: `fact_${fact.status}` };
  }
  if (isExpired(fact, now)) {
    return { status: 'requires_user', factId: fact.id, reason: 'fact_expired' };
  }
  if (purpose === 'application' && fact.usePolicy !== 'auto_fill') {
    return { status: 'requires_user', factId: fact.id, reason: fact.usePolicy };
  }
  if (purpose === 'application' && fact.sensitivity === 'high_risk') {
    return { status: 'requires_user', factId: fact.id, reason: 'high_risk_value' };
  }
  return { status: 'resolved', factId: fact.id, value: fact.value };
}

export type GroundedClaim = {
  text: string;
  evidenceFactIds: string[];
};

export type GroundingResult =
  { grounded: true } | { grounded: false; unsupportedClaimIndexes: number[]; reasons: string[] };

export function validateClaimsAreGrounded(
  claims: GroundedClaim[],
  facts: ReadonlyMap<string, KnowledgeFact<unknown>>,
  now = new Date(),
): GroundingResult {
  const unsupportedClaimIndexes: number[] = [];
  const reasons: string[] = [];

  claims.forEach((claim, claimIndex) => {
    const claimKey = String(claimIndex);
    if (claim.evidenceFactIds.length === 0) {
      unsupportedClaimIndexes.push(claimIndex);
      reasons.push(`claim_${claimKey}:missing_evidence`);
      return;
    }

    for (const factId of claim.evidenceFactIds) {
      const fact = facts.get(factId);
      if (fact === undefined) {
        unsupportedClaimIndexes.push(claimIndex);
        reasons.push(`claim_${claimKey}:unknown_fact:${factId}`);
        break;
      }
      const resolution = resolveFact(fact, 'application', now);
      if (resolution.status !== 'resolved') {
        unsupportedClaimIndexes.push(claimIndex);
        reasons.push(`claim_${claimKey}:${resolution.reason}:${factId}`);
        break;
      }
    }
  });

  if (unsupportedClaimIndexes.length === 0) return { grounded: true };
  return {
    grounded: false,
    unsupportedClaimIndexes: [...new Set(unsupportedClaimIndexes)],
    reasons,
  };
}

export const requiredProfileFactPrefixes = [
  'identity.',
  'contact.',
  'work_authorisation.',
  'preferences.minimum_salary_gbp',
  'preferences.target_roles',
  'preferences.location',
  'preferences.work_pattern',
  'preferences.contract_type',
  'preferences.hours',
  'eligibility.notice_period',
  'employment.',
  'education.',
  'skills.',
  'documents.cv',
] as const;

export function findMissingProfileCategories(facts: readonly KnowledgeFact<unknown>[]): string[] {
  return requiredProfileFactPrefixes.filter(
    (prefix) =>
      !facts.some(
        (fact) =>
          (fact.key === prefix || fact.key.startsWith(prefix)) &&
          fact.status === 'verified' &&
          fact.value !== null,
      ),
  );
}
