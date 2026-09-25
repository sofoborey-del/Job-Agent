import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export const SUBMIT_INTENT_TTL_SECONDS = 180;

export type IssuedSubmitIntent = {
  /** Given to the worker once and never stored. Only its hash is persisted. */
  token: string;
  tokenHash: string;
  snapshotHash: string;
  expiresAt: string;
};

export function hashSubmitToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function issueSubmitIntent(input: {
  snapshotHash: string;
  now: Date;
  ttlSeconds?: number;
}): IssuedSubmitIntent {
  const token = randomBytes(32).toString('base64url');
  return {
    token,
    tokenHash: hashSubmitToken(token),
    snapshotHash: input.snapshotHash,
    expiresAt: new Date(
      input.now.getTime() + (input.ttlSeconds ?? SUBMIT_INTENT_TTL_SECONDS) * 1000,
    ).toISOString(),
  };
}

export function tokenMatches(token: string, expectedHash: string): boolean {
  const provided = Buffer.from(hashSubmitToken(token), 'utf8');
  const expected = Buffer.from(expectedHash, 'utf8');
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(provided, expected);
}

export type SubmitEligibilityInput = {
  workflowState: string;
  targetOrigin: string;
  isFakeTarget: boolean;
  approval: {
    snapshotHash: string;
    decision: 'approved' | 'rejected';
    consumedAt: string | null;
    expiresAt: string;
  } | null;
  currentSnapshotHash: string;
  outstandingQuestions: number;
  ledgerStatus: 'none' | 'reserved' | 'confirmed' | 'unknown' | 'released';
  now: Date;
};

export type SubmitEligibility =
  { allowed: true } | { allowed: false; reason: string; message: string };

/**
 * The last gate before a final action. Every clause here must hold, and the approval must still
 * describe exactly the answers about to be submitted.
 */
export function checkSubmitEligibility(input: SubmitEligibilityInput): SubmitEligibility {
  if (!input.isFakeTarget) {
    return {
      allowed: false,
      reason: 'target_not_fake_ats',
      message: 'Only the local fake ATS may be submitted to in this phase.',
    };
  }
  if (input.workflowState !== 'READY_TO_SUBMIT') {
    return {
      allowed: false,
      reason: 'state_not_ready',
      message: 'The application is not ready to submit.',
    };
  }
  if (input.approval === null) {
    return { allowed: false, reason: 'no_approval', message: 'No approval has been given.' };
  }
  if (input.approval.decision !== 'approved') {
    return { allowed: false, reason: 'approval_rejected', message: 'The review was rejected.' };
  }
  if (input.approval.consumedAt !== null) {
    return {
      allowed: false,
      reason: 'approval_already_used',
      message: 'That approval has already been used. Approvals are single use.',
    };
  }
  if (new Date(input.approval.expiresAt) <= input.now) {
    return { allowed: false, reason: 'approval_expired', message: 'The approval has expired.' };
  }
  if (input.approval.snapshotHash !== input.currentSnapshotHash) {
    return {
      allowed: false,
      reason: 'snapshot_changed',
      message:
        'The answers, job, CV, adapter or form have changed since you approved. A fresh review is required.',
    };
  }
  if (input.outstandingQuestions > 0) {
    return {
      allowed: false,
      reason: 'questions_outstanding',
      message: 'Some questions are still waiting for you.',
    };
  }
  if (input.ledgerStatus === 'confirmed' || input.ledgerStatus === 'reserved') {
    return {
      allowed: false,
      reason: 'already_submitted',
      message: 'A final action has already been reserved or completed for this application.',
    };
  }
  if (input.ledgerStatus === 'unknown') {
    return {
      allowed: false,
      reason: 'awaiting_reconciliation',
      message:
        'The previous attempt ended without a clear result. It must be reconciled by hand before anything else happens.',
    };
  }
  return { allowed: true };
}

export function submissionIdempotencyKey(input: {
  applicationId: string;
  attemptId: string;
  snapshotHash: string;
}): string {
  return createHash('sha256')
    .update([input.applicationId, input.attemptId, input.snapshotHash].join('\u001f'))
    .digest('hex');
}
