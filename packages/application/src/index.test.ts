import { describe, expect, it } from 'vitest';

import {
  InvalidApplicationTransitionError,
  assertSubmitTransitionHasIntent,
  canTransition,
  transitionApplication,
} from './index.js';

describe('application state machine', () => {
  it('allows a normal discovery transition', () => {
    expect(canTransition('DISCOVERED', 'NORMALIZED')).toBe(true);
    const event = transitionApplication('DISCOVERED', 'NORMALIZED', {
      applicationId: 'application-1',
      sequence: 1,
      actor: 'system',
      reason: 'Job normalised.',
      occurredAt: '2026-09-23T12:00:00.000Z',
      correlationId: 'correlation-1',
    });
    expect(event.from).toBe('DISCOVERED');
    expect(event.to).toBe('NORMALIZED');
  });

  it('rejects an attempt to jump directly to submitted', () => {
    expect(() =>
      transitionApplication('FILLING', 'SUBMITTED', {
        applicationId: 'application-1',
        sequence: 2,
        actor: 'worker',
        reason: 'Unsafe jump.',
        occurredAt: '2026-09-23T12:00:01.000Z',
        correlationId: 'correlation-1',
      }),
    ).toThrow(InvalidApplicationTransitionError);
  });

  it('requires a fresh one-use intent before submitting', () => {
    expect(() => assertSubmitTransitionHasIntent('READY_TO_SUBMIT', 'SUBMITTING', false)).toThrow(
      'A fresh one-use submit intent is required',
    );
    expect(() =>
      assertSubmitTransitionHasIntent('READY_TO_SUBMIT', 'SUBMITTING', true),
    ).not.toThrow();
  });

  it('does not permit a blind retry from an uncertain submission outcome', () => {
    expect(canTransition('SUBMISSION_UNKNOWN', 'SUBMITTING')).toBe(false);
    expect(canTransition('SUBMISSION_UNKNOWN', 'WAITING_USER')).toBe(true);
  });
});
