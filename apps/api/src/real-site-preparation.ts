import { isApprovedRealSiteUrl, type RealSiteAdapter } from '@job-agent/browser-core';

/**
 * The state the tracker's "Prepare application" control shows for one job.
 *
 * The order these are decided in matters: a job already submitted, closed or restricted is
 * reported as such before anything is said about whether an adapter exists, so a duplicate can
 * never be presented as ready to prepare.
 */
export const preparationStatuses = [
  'already_submitted',
  'blocked_closed',
  'blocked_ineligible',
  'unavailable',
  'awaiting_login',
  'preparing',
  'needs_user_input',
  'ready_for_review',
] as const;
export type PreparationStatus = (typeof preparationStatuses)[number];

export type PreparationView = {
  status: PreparationStatus;
  /** Plain English, written for the person rather than the log. */
  message: string;
  /** A short machine-readable reason, for the audit record. */
  reason: string;
  /** True only when the agent may actually type into the employer's form. */
  prefillPermitted: boolean;
  /** Always false in this milestone. */
  autoSubmitEnabled: false;
  adapter: { id: string; version: string; providerName: string } | null;
};

export type PreparationInput = {
  /** The employer application address, when the advert gives one. */
  applyUrl: string | null;
  lifecycleStatus: string;
  closesAt: string | null;
  hardRejectReasons: readonly string[];
  externalSubmission: { providerReference: string; submittedAt: string } | null;
  /** The reviewed adapter for this domain, when one exists. */
  adapter: RealSiteAdapter | null;
  /** Whether the reviewed site policy currently permits prefill on this domain. */
  sitePolicyPermitsPrefill: boolean;
  /** Set once the user says they have signed in and cleared any challenge themselves. */
  userAuthenticated: boolean;
  /** The live attempt's state, when one exists. */
  attempt: { openQuestions: number; reachedReview: boolean } | null;
  now?: Date;
};

function describe(
  status: PreparationStatus,
  reason: string,
  message: string,
  adapter: RealSiteAdapter | null,
  prefillPermitted = false,
): PreparationView {
  return {
    status,
    reason,
    message,
    prefillPermitted,
    autoSubmitEnabled: false,
    adapter:
      adapter === null
        ? null
        : { id: adapter.id, version: adapter.version, providerName: adapter.providerName },
  };
}

export function preparationView(input: PreparationInput): PreparationView {
  const now = input.now ?? new Date();
  const adapter = input.adapter;

  // 1. Never offer to prepare something already sent.
  if (input.externalSubmission !== null) {
    return describe(
      'already_submitted',
      'external_submission_recorded',
      `You recorded this as submitted on ${input.externalSubmission.submittedAt.slice(0, 10)}. Do not apply again.`,
      adapter,
    );
  }

  // 2. Closed or withdrawn.
  if (
    ['closed', 'expired', 'duplicate', 'withdrawn'].includes(input.lifecycleStatus) ||
    (input.closesAt !== null && new Date(input.closesAt).getTime() <= now.getTime())
  ) {
    return describe(
      'blocked_closed',
      'job_closed',
      'This vacancy is closed, so there is nothing to prepare.',
      adapter,
    );
  }

  // 3. Eligibility gates that no amount of prefill can satisfy.
  if (input.hardRejectReasons.includes('restricted_to_internal_candidates')) {
    return describe(
      'blocked_ineligible',
      'restricted_to_internal_candidates',
      'This vacancy is open only to the employer’s existing staff or a named programme.',
      adapter,
    );
  }
  if (input.hardRejectReasons.length > 0) {
    return describe(
      'blocked_ineligible',
      input.hardRejectReasons[0] ?? 'hard_gate_failed',
      'A hard eligibility gate failed for this vacancy. Open it and check before applying.',
      adapter,
    );
  }

  // 4. Is there anything that could drive this site at all?
  if (input.applyUrl === null) {
    return describe(
      'unavailable',
      'no_application_url',
      'This advert does not publish an application address the agent can recognise.',
      adapter,
    );
  }
  if (adapter === null) {
    return describe(
      'unavailable',
      'no_reviewed_adapter',
      'There is no reviewed adapter for this application site. Apply on the site yourself.',
      null,
    );
  }
  if (!isApprovedRealSiteUrl(input.applyUrl, adapter.approvedDomains)) {
    return describe(
      'unavailable',
      'url_not_on_approved_domain',
      'The application address is not on an approved domain for that adapter.',
      adapter,
    );
  }
  if (adapter.executionMode !== 'prefill_only') {
    return describe(
      'unavailable',
      'adapter_execution_disabled',
      'Assisted filling is switched off for this site. The details below are for you to copy.',
      adapter,
    );
  }
  if (!input.sitePolicyPermitsPrefill) {
    return describe(
      'unavailable',
      'site_policy_forbids_prefill',
      'The reviewed site policy for this domain does not permit assisted filling.',
      adapter,
    );
  }

  // 5. The user signs in; the agent never does.
  if (!input.userAuthenticated) {
    return describe(
      'awaiting_login',
      'user_must_sign_in',
      'Sign in on the employer site yourself, complete any security check, then continue.',
      adapter,
      true,
    );
  }

  // 6. What the live attempt is doing.
  if (input.attempt === null) {
    return describe(
      'preparing',
      'ready_to_start',
      'Ready to fill the fields it can evidence. It will stop at anything it cannot.',
      adapter,
      true,
    );
  }
  if (input.attempt.openQuestions > 0) {
    return describe(
      'needs_user_input',
      'questions_open',
      `${String(input.attempt.openQuestions)} question(s) need your answer before it can go on.`,
      adapter,
      true,
    );
  }
  if (input.attempt.reachedReview) {
    return describe(
      'ready_for_review',
      'review_ready',
      'Everything it could fill is filled. Check every answer, then submit the form yourself.',
      adapter,
      true,
    );
  }
  return describe('preparing', 'in_progress', 'Filling the fields it can evidence.', adapter, true);
}
