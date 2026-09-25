import type { MatchAction } from '@job-agent/domain';

/** What the advert itself is doing. Set by discovery, never by the user. */
export const lifecycleStatuses = ['open', 'changed', 'closed', 'expired', 'duplicate'] as const;
export type LifecycleStatus = (typeof lifecycleStatuses)[number];

/** What the user (or the deterministic matcher, on their behalf) has decided. */
export const reviewStatuses = [
  'discovered',
  'rejected',
  'shortlisted',
  'reviewed',
  'archived',
] as const;
export type ReviewStatus = (typeof reviewStatuses)[number];

const allowedReviewTransitions: Readonly<Record<ReviewStatus, readonly ReviewStatus[]>> = {
  discovered: ['shortlisted', 'rejected', 'reviewed', 'archived'],
  shortlisted: ['reviewed', 'rejected', 'archived', 'discovered'],
  rejected: ['discovered', 'shortlisted', 'archived'],
  reviewed: ['shortlisted', 'rejected', 'archived'],
  archived: ['discovered'],
};

export class InvalidReviewTransitionError extends Error {
  constructor(
    readonly from: ReviewStatus,
    readonly to: ReviewStatus,
  ) {
    super(`Cannot move a job from ${from} to ${to}`);
    this.name = 'InvalidReviewTransitionError';
  }
}

export function canChangeReviewStatus(from: ReviewStatus, to: ReviewStatus): boolean {
  if (from === to) return true;
  return allowedReviewTransitions[from].includes(to);
}

export function assertReviewTransition(from: ReviewStatus, to: ReviewStatus): void {
  if (!canChangeReviewStatus(from, to)) throw new InvalidReviewTransitionError(from, to);
}

export function reviewTransitionsFrom(from: ReviewStatus): readonly ReviewStatus[] {
  return allowedReviewTransitions[from];
}

/**
 * The deterministic matcher may only set an opening position. A decision the user has made is
 * never overwritten by a later automatic run.
 */
export function automaticReviewStatusFor(action: MatchAction): ReviewStatus {
  return action === 'reject' ? 'rejected' : 'shortlisted';
}

export function mayApplyAutomaticReview(
  current: ReviewStatus,
  decidedBy: 'system' | 'user',
): boolean {
  return (
    decidedBy === 'system' &&
    (current === 'discovered' || current === 'shortlisted' || current === 'rejected')
  );
}

/** Lifecycle statuses that stop a job being worth acting on. */
export function isLifecycleFinal(status: LifecycleStatus): boolean {
  return status === 'closed' || status === 'expired' || status === 'duplicate';
}
