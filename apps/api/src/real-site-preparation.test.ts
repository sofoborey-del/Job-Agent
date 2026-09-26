import { describe, expect, it } from 'vitest';

import { myJobScotlandAdapter } from '@job-agent/adapters';

import { preparationView, type PreparationInput } from './real-site-preparation.js';

const applyUrl = 'https://emea3.recruitmentplatform.com/apply/GLA12345';

function input(overrides: Partial<PreparationInput> = {}): PreparationInput {
  return {
    applyUrl,
    lifecycleStatus: 'open',
    closesAt: null,
    hardRejectReasons: [],
    externalSubmission: null,
    adapter: myJobScotlandAdapter('prefill_only'),
    sitePolicyPermitsPrefill: true,
    userAuthenticated: true,
    attempt: null,
    ...overrides,
  };
}

describe('what the Prepare application control shows', () => {
  it('reports an already-submitted job before anything else', () => {
    // Even with everything else wrong, the duplicate guard answers first.
    const view = preparationView(
      input({
        externalSubmission: { providerReference: 'GLA15975', submittedAt: '2026-09-20T10:00:00Z' },
        lifecycleStatus: 'closed',
        hardRejectReasons: ['restricted_to_internal_candidates'],
      }),
    );
    expect(view.status).toBe('already_submitted');
    expect(view.prefillPermitted).toBe(false);
    expect(view.message).toContain('2026-09-20');
  });

  it('blocks a closed vacancy', () => {
    expect(preparationView(input({ lifecycleStatus: 'closed' })).status).toBe('blocked_closed');
  });

  it('blocks a vacancy whose closing date has passed', () => {
    expect(preparationView(input({ closesAt: '2020-01-01T00:00:00Z' })).status).toBe(
      'blocked_closed',
    );
  });

  it('blocks a vacancy restricted to existing staff', () => {
    const view = preparationView(
      input({ hardRejectReasons: ['restricted_to_internal_candidates'] }),
    );
    expect(view.status).toBe('blocked_ineligible');
    expect(view.reason).toBe('restricted_to_internal_candidates');
  });

  it('reports unavailable when the advert gives no application address', () => {
    expect(preparationView(input({ applyUrl: null })).reason).toBe('no_application_url');
  });

  it('reports unavailable when no adapter covers the site', () => {
    const view = preparationView(input({ adapter: null }));
    expect(view.status).toBe('unavailable');
    expect(view.adapter).toBeNull();
  });

  it('reports unavailable when the address is off the approved domains', () => {
    const view = preparationView(input({ applyUrl: 'https://careers.example.com/apply' }));
    expect(view.reason).toBe('url_not_on_approved_domain');
  });

  it('reports unavailable while the adapter is switched off', () => {
    const view = preparationView(input({ adapter: myJobScotlandAdapter() }));
    expect(view.status).toBe('unavailable');
    expect(view.reason).toBe('adapter_execution_disabled');
    expect(view.prefillPermitted).toBe(false);
  });

  it('reports unavailable while the site policy forbids prefill', () => {
    const view = preparationView(input({ sitePolicyPermitsPrefill: false }));
    expect(view.reason).toBe('site_policy_forbids_prefill');
    expect(view.prefillPermitted).toBe(false);
  });

  it('waits for the user to sign in themselves', () => {
    const view = preparationView(input({ userAuthenticated: false }));
    expect(view.status).toBe('awaiting_login');
    expect(view.message).toContain('yourself');
  });

  it('is ready to prepare once signed in', () => {
    expect(preparationView(input()).status).toBe('preparing');
  });

  it('asks for input when questions are open', () => {
    const view = preparationView(input({ attempt: { openQuestions: 3, reachedReview: false } }));
    expect(view.status).toBe('needs_user_input');
    expect(view.message).toContain('3 question');
  });

  it('offers review once everything fillable is filled', () => {
    const view = preparationView(input({ attempt: { openQuestions: 0, reachedReview: true } }));
    expect(view.status).toBe('ready_for_review');
    expect(view.message).toContain('yourself');
  });

  it('never reports auto-submit as enabled, in any state', () => {
    const states: Partial<PreparationInput>[] = [
      {},
      { lifecycleStatus: 'closed' },
      { adapter: null },
      { userAuthenticated: false },
      { attempt: { openQuestions: 0, reachedReview: true } },
      { externalSubmission: { providerReference: 'X', submittedAt: '2026-01-01T00:00:00Z' } },
    ];
    for (const state of states) {
      expect(preparationView(input(state)).autoSubmitEnabled).toBe(false);
    }
  });

  it('permits prefill only once every gate has passed', () => {
    const blocked: Partial<PreparationInput>[] = [
      { adapter: myJobScotlandAdapter() },
      { sitePolicyPermitsPrefill: false },
      { applyUrl: 'https://careers.example.com/apply' },
      { adapter: null },
      { lifecycleStatus: 'closed' },
      { hardRejectReasons: ['salary_below_floor'] },
      { externalSubmission: { providerReference: 'X', submittedAt: '2026-01-01T00:00:00Z' } },
    ];
    for (const state of blocked) {
      expect(preparationView(input(state)).prefillPermitted).toBe(false);
    }
  });
});
