import { createHash } from 'node:crypto';

import type { KnowledgeFact } from '@job-agent/domain';

/**
 * Identifies the exact set of verified facts a decision was made from, without storing or hashing
 * any applicant value. Only fact ids, versions and status are used.
 */
export function profileSnapshotHash(facts: readonly KnowledgeFact<unknown>[]): string {
  const material = facts
    .map(
      (fact) =>
        `${fact.id}:${String(fact.version)}:${fact.status}:${fact.allowedPurposes.join('+')}`,
    )
    .sort((left, right) => left.localeCompare(right))
    .join('\u001f');
  return createHash('sha256').update(material).digest('hex');
}

export function matchIdempotencyKey(input: {
  userId: string;
  jobId: string;
  jobVersion: number;
  profileSnapshotHash: string;
  matcherVersion: string;
  configHash: string;
}): string {
  return createHash('sha256')
    .update(
      [
        input.userId,
        input.jobId,
        String(input.jobVersion),
        input.profileSnapshotHash,
        input.matcherVersion,
        input.configHash,
      ].join('\u001f'),
    )
    .digest('hex');
}
