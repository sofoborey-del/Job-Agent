import type { KnowledgeFact } from '@job-agent/domain';
import { describe, expect, it } from 'vitest';

import { matchIdempotencyKey, profileSnapshotHash } from './profile-snapshot.js';
import { extractJobRequirements } from './requirements.js';
import {
  assertReviewTransition,
  automaticReviewStatusFor,
  canChangeReviewStatus,
  isLifecycleFinal,
  mayApplyAutomaticReview,
} from './state.js';

function fact(id: string, value: unknown, version = 1): KnowledgeFact<unknown> {
  return {
    id,
    key: 'skills.security',
    value,
    status: 'verified',
    source: 'user',
    sensitivity: 'normal',
    usePolicy: 'auto_fill',
    allowedPurposes: ['matching'],
    version,
  };
}

describe('review status transitions', () => {
  it('allows the everyday moves a person makes on the tracker', () => {
    expect(canChangeReviewStatus('discovered', 'shortlisted')).toBe(true);
    expect(canChangeReviewStatus('shortlisted', 'reviewed')).toBe(true);
    expect(canChangeReviewStatus('reviewed', 'rejected')).toBe(true);
    expect(canChangeReviewStatus('archived', 'discovered')).toBe(true);
  });

  it('refuses a move that would skip the archive rules', () => {
    expect(canChangeReviewStatus('archived', 'shortlisted')).toBe(false);
    expect(() => {
      assertReviewTransition('archived', 'reviewed');
    }).toThrow('Cannot move a job from archived to reviewed');
  });

  it('treats a repeat of the same status as harmless', () => {
    expect(canChangeReviewStatus('shortlisted', 'shortlisted')).toBe(true);
  });
});

describe('automatic decisions', () => {
  it('maps matcher actions onto an opening tracker position', () => {
    expect(automaticReviewStatusFor('reject')).toBe('rejected');
    expect(automaticReviewStatusFor('shortlist')).toBe('shortlisted');
    expect(automaticReviewStatusFor('prefill_with_approval')).toBe('shortlisted');
  });

  it('never overrides a decision the user made', () => {
    expect(mayApplyAutomaticReview('shortlisted', 'user')).toBe(false);
    expect(mayApplyAutomaticReview('rejected', 'user')).toBe(false);
    expect(mayApplyAutomaticReview('discovered', 'system')).toBe(true);
  });

  it('knows which advert states are finished', () => {
    expect(isLifecycleFinal('closed')).toBe(true);
    expect(isLifecycleFinal('expired')).toBe(true);
    expect(isLifecycleFinal('open')).toBe(false);
  });
});

describe('profile snapshot identity', () => {
  it('identifies the fact set without using any applicant value', () => {
    const withValues = profileSnapshotHash([fact('a', 'Security+'), fact('b', 'Glasgow')]);
    const sameFactsDifferentValues = profileSnapshotHash([
      fact('a', 'something else entirely'),
      fact('b', 'another place'),
    ]);
    expect(withValues).toBe(sameFactsDifferentValues);
  });

  it('changes when a fact is added or a version moves on', () => {
    const base = profileSnapshotHash([fact('a', 'x')]);
    expect(profileSnapshotHash([fact('a', 'x', 2)])).not.toBe(base);
    expect(profileSnapshotHash([fact('a', 'x'), fact('b', 'y')])).not.toBe(base);
  });

  it('produces a stable match key for the same inputs', () => {
    const input = {
      userId: 'user-1',
      jobId: 'job-1',
      jobVersion: 2,
      profileSnapshotHash: 'abc',
      matcherVersion: 'shadow-1.1.0',
      configHash: 'def',
    };
    expect(matchIdempotencyKey(input)).toBe(matchIdempotencyKey(input));
    expect(matchIdempotencyKey({ ...input, jobVersion: 3 })).not.toBe(matchIdempotencyKey(input));
  });
});

describe('requirement extraction', () => {
  it('keeps the advert wording and labels the kind of requirement', () => {
    const requirements = extractJobRequirements(
      'You must hold a current driving licence.\nA relevant degree is essential.\nWe offer a pension.',
    );
    expect(requirements).toHaveLength(2);
    expect(requirements.map((requirement) => requirement.category)).toEqual([
      'licence',
      'qualification',
    ]);
    expect(requirements.every((requirement) => requirement.mandatory)).toBe(true);
  });
});
