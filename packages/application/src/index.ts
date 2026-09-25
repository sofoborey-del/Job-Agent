import type { ApplicationEvent, ApplicationState } from '@job-agent/domain';

const allowedTransitions: Readonly<Record<ApplicationState, readonly ApplicationState[]>> = {
  DISCOVERED: ['NORMALIZED'],
  NORMALIZED: ['REJECTED', 'SCORED'],
  REJECTED: [],
  SCORED: ['REJECTED', 'SHORTLISTED', 'QUEUED'],
  SHORTLISTED: ['QUEUED', 'CANCELLED'],
  QUEUED: ['STARTING', 'CANCELLED'],
  STARTING: ['FILLING', 'RETRYABLE_FAILED', 'PERMANENT_FAILED', 'WAITING_USER', 'WAITING_TAKEOVER'],
  FILLING: [
    'WAITING_USER',
    'WAITING_TAKEOVER',
    'READY_FOR_REVIEW',
    'RETRYABLE_FAILED',
    'PERMANENT_FAILED',
    'CANCELLED',
  ],
  WAITING_USER: ['FILLING', 'CANCELLED', 'SUBMITTED', 'WAITING_TAKEOVER'],
  WAITING_TAKEOVER: ['FILLING', 'CANCELLED'],
  READY_FOR_REVIEW: ['WAITING_APPROVAL', 'READY_TO_SUBMIT', 'FILLING'],
  WAITING_APPROVAL: ['READY_TO_SUBMIT', 'CANCELLED', 'FILLING'],
  READY_TO_SUBMIT: ['SUBMITTING', 'FILLING', 'CANCELLED', 'WAITING_USER', 'WAITING_TAKEOVER'],
  SUBMITTING: ['SUBMITTED', 'SUBMISSION_UNKNOWN'],
  SUBMITTED: ['FOLLOW_UP'],
  SUBMISSION_UNKNOWN: ['SUBMITTED', 'WAITING_USER', 'PERMANENT_FAILED'],
  RETRYABLE_FAILED: ['QUEUED', 'CANCELLED', 'PERMANENT_FAILED'],
  PERMANENT_FAILED: [],
  CANCELLED: [],
  FOLLOW_UP: ['CLOSED'],
  CLOSED: [],
};

export class InvalidApplicationTransitionError extends Error {
  constructor(from: ApplicationState, to: ApplicationState) {
    super(`Invalid application transition: ${from} -> ${to}`);
    this.name = 'InvalidApplicationTransitionError';
  }
}

export function canTransition(from: ApplicationState, to: ApplicationState): boolean {
  return allowedTransitions[from].includes(to);
}

export function transitionApplication(
  current: ApplicationState,
  to: ApplicationState,
  context: Omit<ApplicationEvent, 'from' | 'to'>,
): ApplicationEvent {
  if (!canTransition(current, to)) throw new InvalidApplicationTransitionError(current, to);
  return { ...context, from: current, to };
}

export function assertSubmitTransitionHasIntent(
  current: ApplicationState,
  to: ApplicationState,
  hasFreshSubmitIntent: boolean,
): void {
  if (current === 'READY_TO_SUBMIT' && to === 'SUBMITTING' && !hasFreshSubmitIntent) {
    throw new Error('A fresh one-use submit intent is required');
  }
}

export * from './types.js';
export * from './ports.js';
export * from './workflow.js';
