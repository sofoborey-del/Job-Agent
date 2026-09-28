import { describe, expect, it } from 'vitest';

import { defaultAgentConfig } from '@job-agent/config';
import type { KnowledgeFact } from '@job-agent/domain';

import { shadowMatch, type ShadowJob } from './shadow.js';

const config = defaultAgentConfig;

/**
 * An advert that arrives as an excerpt must never look like an advert whose criteria were read.
 *
 * This is the failure the user rejected in September, in a new guise: then it was a page summary
 * standing in for an unopened criteria document, now it is an aggregator's snippet standing in for
 * the advert. The rule is the same — criteria nobody has seen are not criteria that were met.
 */

function fact(key: string, value: unknown): KnowledgeFact<unknown> {
  return {
    id: `00000000-0000-4000-8000-${key.length.toString().padStart(12, '0')}`,
    key,
    value,
    status: 'verified',
    source: 'user',
    sensitivity: 'normal',
    usePolicy: 'auto_fill',
    allowedPurposes: ['matching', 'application'],
    version: 1,
  };
}

const facts = [
  fact('skills.list', ['customer service', 'record keeping', 'Microsoft Office']),
  fact('preferences.target_roles', ['Customer Service Adviser']),
  fact('preferences.location', ['Glasgow']),
];

function job(overrides: Partial<ShadowJob> = {}): ShadowJob {
  return {
    id: '00000000-0000-4000-8000-00000000feed',
    title: 'Customer Service Adviser',
    employer: 'Invented Retail Ltd',
    description:
      'Handle customer enquiries for a busy team. You must have experience of customer service and record keeping.',
    location: 'Glasgow',
    salary: {
      minimumMinor: 2_700_000,
      maximumMinor: 2_900_000,
      currency: 'GBP',
      basis: 'annual_base',
      confidence: 0.8,
      sourceText: 'Adzuna',
    },
    contractType: 'permanent',
    employmentTypes: ['full_time'],
    workPattern: 'full_time',
    closesAt: null,
    ...overrides,
  };
}

describe('an advert that arrived as an excerpt', () => {
  it('establishes no criteria, however requirement-shaped the excerpt is', () => {
    const full = shadowMatch(job(), facts, config);
    const snippet = shadowMatch(job({ descriptionCompleteness: 'snippet' }), facts, config);

    expect(full.criteria.visible).toBe(true);
    expect(snippet.criteria.visible).toBe(false);
    expect(snippet.criteria.descriptionCompleteness).toBe('snippet');
  });

  it('blocks automatic progression', () => {
    const snippet = shadowMatch(job({ descriptionCompleteness: 'snippet' }), facts, config);
    expect(snippet.decision.autoBlockers).toContain('advert_text_truncated');
    expect(snippet.decision.autoBlockers).toContain('no_mandatory_criteria_visible');
  });

  it('is never auto-applied for', () => {
    const snippet = shadowMatch(job({ descriptionCompleteness: 'snippet' }), facts, config);
    expect(snippet.decision.action).not.toBe('auto_apply');
  });

  it('is surfaced for review rather than rejected on a score it could not earn', () => {
    // A poor-looking excerpt: almost nothing for the matcher to work with.
    const poor = shadowMatch(
      job({ descriptionCompleteness: 'snippet', description: 'An opportunity has arisen.' }),
      facts,
      config,
    );
    expect(poor.decision.action).toBe('shortlist');
    expect(poor.decision.explanation.join(' ')).toContain('excerpt');
  });

  it('still loses to a hard gate', () => {
    const closed = shadowMatch(
      job({ descriptionCompleteness: 'snippet', closesAt: '2020-01-01T00:00:00.000Z' }),
      facts,
      config,
    );
    expect(closed.decision.action).toBe('reject');
  });

  /**
   * An aggregator salary is Adzuna's normalisation of someone else's advert, so it is deliberately
   * carried below the confidence the salary gate demands. The consequence is that it can never by
   * itself satisfy the GBP 25,000 floor: it resolves to unknown, which blocks automatic
   * progression. Below-floor adverts are kept out at the request instead, by passing salary_min to
   * the API, and the person confirms the real figure on the advert.
   */
  it('never lets an aggregator salary satisfy the floor by itself', () => {
    const lowConfidence = shadowMatch(job({ descriptionCompleteness: 'snippet' }), facts, config);
    expect(lowConfidence.salaryGate).toBe('unknown');
    expect(lowConfidence.decision.autoBlockers).toContain('salary_unknown');
  });

  it('still loses to the salary floor when the figure is stated with confidence', () => {
    const lowPaid = shadowMatch(
      job({
        descriptionCompleteness: 'snippet',
        salary: {
          minimumMinor: 1_800_000,
          maximumMinor: 1_900_000,
          currency: 'GBP',
          basis: 'annual_base',
          confidence: 0.95,
          sourceText: 'Stated on the advert',
        },
      }),
      facts,
      config,
    );
    expect(lowPaid.decision.action).toBe('reject');
    expect(lowPaid.decision.hardRejectReasons).toContain('salary_below_floor');
  });

  it('still detects an internal-only restriction inside the excerpt', () => {
    const restricted = shadowMatch(
      job({
        descriptionCompleteness: 'snippet',
        description: 'This post is open only to current employees of the council.',
      }),
      facts,
      config,
    );
    expect(restricted.decision.action).toBe('reject');
    expect(restricted.decision.hardRejectReasons).toContain('restricted_to_internal_candidates');
  });

  it('leaves a full advert exactly as it was', () => {
    const before = shadowMatch(job(), facts, config);
    expect(before.decision.autoBlockers).not.toContain('advert_text_truncated');
    expect(before.criteria.descriptionCompleteness).toBe('full');
  });
});
