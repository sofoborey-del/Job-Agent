import { describe, expect, it } from 'vitest';

import type { KnowledgeFact } from '@job-agent/domain';

import { shadowMatch } from './shadow.js';

function fact(id: string, key: string, value: unknown): KnowledgeFact<unknown> {
  return {
    id,
    key,
    value,
    status: 'verified',
    source: 'user',
    verifiedAt: '2026-09-25T09:00:00.000Z',
    sensitivity: 'normal',
    usePolicy: 'auto_fill',
    allowedPurposes: ['matching', 'application'],
    version: 1,
  };
}

const profile = [
  fact('roles', 'preferences.target_roles', ['customer service adviser', 'claims handler']),
  fact('locations', 'preferences.location', ['Glasgow', 'UK remote']),
  fact('contracts', 'preferences.contract_type', ['permanent']),
  fact('exclusions', 'preferences.exclusions', ['commission-only']),
  fact('skills', 'skills.list', ['customer service', 'complaint handling', 'Microsoft Excel']),
  fact('employment', 'employment.history', [
    { title: 'Customer Service Adviser', evidence: 'Resolved complaints and customer enquiries' },
  ]),
  fact('work', 'work_authorisation.gb', { authorised: true }),
];

describe('deterministic shadow matching', () => {
  it('scores verified evidence but never enables submission', () => {
    const result = shadowMatch(
      {
        id: 'job-1',
        title: 'Customer Services Adviser',
        employer: 'Example Council',
        location: 'Glasgow',
        description:
          'Applicants must have customer service experience. Complaint handling experience is essential.',
        salary: {
          minimumMinor: 2_800_000,
          maximumMinor: 3_100_000,
          currency: 'GBP',
          basis: 'annual_base',
          confidence: 0.99,
          sourceText: '£28,000 - £31,000 per year',
        },
        contractType: 'Permanent',
        employmentTypes: ['FULL_TIME'],
        workPattern: 'Hybrid',
        closesAt: '2026-10-20T23:59:59Z',
      },
      profile,
      undefined,
      new Date('2026-09-25T12:00:00Z'),
    );
    expect(result.salaryGate).toBe('pass');
    expect(result.requirements).toHaveLength(2);
    expect(result.requirements.every((requirement) => requirement.outcome === 'met')).toBe(true);
    expect(result.decision.action).not.toBe('auto_apply');
    expect(result.decision.autoBlockers).toContain('site_policy_prefill_only');
    expect(result.mode).toBe('shadow_only');
  });

  it('rejects salary below the configured floor and preserves unknown requirements', () => {
    const result = shadowMatch(
      {
        id: 'job-2',
        title: 'Specialist Surveyor',
        employer: 'Example Council',
        location: 'Edinburgh',
        description: 'A chartered surveyor qualification is essential.',
        salary: {
          maximumMinor: 2_400_000,
          currency: 'GBP',
          basis: 'annual_base',
          confidence: 0.99,
          sourceText: 'Up to £24,000 per year',
        },
        contractType: 'Permanent',
        employmentTypes: ['FULL_TIME'],
        workPattern: null,
        closesAt: null,
      },
      profile,
    );
    expect(result.salaryGate).toBe('reject');
    expect(result.decision.hardRejectReasons).toContain('salary_below_floor');
    expect(result.requirements[0]?.outcome).toBe('unknown');
  });
});
