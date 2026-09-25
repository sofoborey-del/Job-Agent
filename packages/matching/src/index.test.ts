import { describe, expect, it } from 'vitest';

import { defaultAgentConfig } from '@job-agent/config';
import type { AnnualSalary } from '@job-agent/domain';

import { calculateScore, decideMatch, evaluateSalary, type DecisionInput } from './index.js';

function salary(minimum: number | undefined, maximum: number | undefined): AnnualSalary {
  return {
    basis: 'annual_base',
    ...(minimum === undefined
      ? {}
      : { minimum: { amountMinor: minimum, currency: 'GBP' as const } }),
    ...(maximum === undefined
      ? {}
      : { maximum: { amountMinor: maximum, currency: 'GBP' as const } }),
    confidence: 0.99,
    sourceText: 'Synthetic salary fixture',
  };
}

const baseInput: DecisionInput = {
  salary: salary(3_000_000, 3_500_000),
  requirements: [
    {
      requirementId: 'req-1',
      outcome: 'met',
      evidenceFactIds: ['fact-1'],
      confidence: 0.98,
      explanation: 'Verified synthetic evidence.',
    },
  ],
  mandatoryRequirementIds: ['req-1'],
  dimensions: {
    mandatoryCoverage: 1,
    relevantSkills: 0.95,
    relevantExperience: 0.9,
    locationFit: 1,
    compensationQuality: 1,
    otherPreferences: 1,
  },
  preferredCriteriaNotMet: 0,
  weakEvidenceCount: 0,
  evidenceCoverage: 0.95,
  decisionConfidence: 0.96,
  locationCompatible: true,
  contractCompatible: true,
  workAuthorisationCompatible: true,
  excluded: false,
  duplicateApplication: false,
  jobOpen: true,
  sitePolicy: 'auto_submit_allowed',
  dailyAutoSlotAvailable: true,
  answersComplete: true,
  humanOnlyStepPresent: false,
};

describe('salary gate', () => {
  it('passes when the minimum is exactly GBP 25,000', () => {
    expect(evaluateSalary(salary(2_500_000, 3_000_000), 2_500_000)).toBe('pass');
  });

  it('rejects when the maximum is below GBP 25,000', () => {
    expect(evaluateSalary(salary(2_000_000, 2_499_999), 2_500_000)).toBe('reject');
  });

  it('returns unknown for an overlapping or missing range', () => {
    expect(evaluateSalary(salary(2_400_000, 3_000_000), 2_500_000)).toBe('unknown');
    expect(evaluateSalary(undefined, 2_500_000)).toBe('unknown');
  });
});

describe('score', () => {
  it('applies bounded preferred and evidence penalties', () => {
    const score = calculateScore(
      {
        mandatoryCoverage: 1,
        relevantSkills: 1,
        relevantExperience: 1,
        locationFit: 1,
        compensationQuality: 1,
        otherPreferences: 1,
      },
      10,
      10,
    );
    expect(score).toBe(65);
  });
});

describe('match decision', () => {
  it('prefills but does not auto-apply while the global safety switch is off', () => {
    const decision = decideMatch(baseInput, defaultAgentConfig);
    expect(decision.score).toBeGreaterThanOrEqual(85);
    expect(decision.action).toBe('prefill_with_approval');
    expect(decision.autoBlockers).toContain('auto_submit_disabled');
  });

  it('hard-rejects a verified missing mandatory prerequisite', () => {
    const decision = decideMatch(
      {
        ...baseInput,
        requirements: [
          {
            requirementId: 'req-1',
            outcome: 'not_met',
            evidenceFactIds: ['fact-contradiction'],
            confidence: 0.99,
            explanation: 'The verified qualification is absent.',
          },
        ],
      },
      defaultAgentConfig,
    );
    expect(decision.action).toBe('reject');
    expect(decision.hardRejectReasons).toContain('mandatory_not_met:req-1');
  });

  it('blocks automatic progression when a mandatory prerequisite is unknown', () => {
    const decision = decideMatch(
      {
        ...baseInput,
        requirements: [
          {
            requirementId: 'req-1',
            outcome: 'unknown',
            evidenceFactIds: [],
            confidence: 0.4,
            explanation: 'No verified evidence exists.',
          },
        ],
      },
      {
        ...defaultAgentConfig,
        submission: { ...defaultAgentConfig.submission, autoEnabled: true },
      },
    );
    expect(decision.action).toBe('prefill_with_approval');
    expect(decision.autoBlockers).toContain('mandatory_unknown:req-1');
  });

  it('can auto-apply only when explicitly enabled and every gate passes', () => {
    const decision = decideMatch(baseInput, {
      ...defaultAgentConfig,
      submission: { ...defaultAgentConfig.submission, autoEnabled: true },
    });
    expect(decision.action).toBe('auto_apply');
    expect(decision.autoBlockers).toEqual([]);
  });
});
