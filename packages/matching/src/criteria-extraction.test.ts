import { describe, expect, it } from 'vitest';

import { defaultAgentConfig } from '@job-agent/config';
import type { KnowledgeFact } from '@job-agent/domain';

import {
  extractMandatoryRequirements,
  reflowSpecificationLines,
  shadowMatch,
  type ShadowJob,
} from './shadow.js';

/**
 * A role profile as pdf.js actually yields it: column-wrapped, bulleted, with a running page
 * footer, and without the word "essential" anywhere. Modelled on a real MyJobScotland profile;
 * the wording is invented.
 */
const wrappedProfile = [
  'Role Profile',
  'Role Title',
  'Delivery',
  'Support Officer',
  'Building a Sustainable Future',
  'Company Overview',
  'The organisation provides services across the city and must meet required standards.',
  'Person Specification',
  'You will:',
  '• Have significant experience within service delivery, administration or a',
  'closely related field.',
  '• Have experience of handling customer enquiries and maintaining accurate',
  'records.',
  'Building a Sustainable Future',
  '• Be able to prioritise competing deadlines without losing accuracy.',
  'Qualifications / Certification',
  '• SVQ Level 3 qualification (or equivalent professional qualification) or significant relevant',
  'experience.',
  '• Postgraduate qualification desirable.',
  'Interdependencies',
  '• Head of Service',
  '• All council employees',
  'Conditions',
  'Your normal place of work will be the city centre office.',
].join('\n');

describe('reflowing a wrapped specification', () => {
  it('rejoins a bullet split across lines', () => {
    const lines = reflowSpecificationLines(wrappedProfile);
    expect(lines).toContain(
      'Have significant experience within service delivery, administration or a closely related field.',
    );
  });

  it('keeps separate bullets separate', () => {
    const lines = reflowSpecificationLines(wrappedProfile);
    const joined = lines.filter((line) => line.startsWith('Have experience of handling'));
    expect(joined).toHaveLength(1);
  });
});

describe('extracting criteria from a real-shaped profile', () => {
  const extracted = extractMandatoryRequirements(wrappedProfile);

  it('finds the criteria even though the profile never says "must" or "essential"', () => {
    expect(wrappedProfile).not.toMatch(/\bessential\b/i);
    expect(extracted.length).toBeGreaterThanOrEqual(4);
  });

  it('reads a criterion that was wrapped across two lines as one', () => {
    expect(
      extracted.some((line) => line.includes('service delivery, administration or a closely')),
    ).toBe(true);
  });

  it('excludes anything the employer calls desirable', () => {
    expect(extracted.some((line) => /desirable/i.test(line))).toBe(false);
  });

  it('excludes the running page footer', () => {
    expect(extracted).not.toContain('Building a Sustainable Future');
  });

  it('stops at the headings that describe the post rather than the candidate', () => {
    expect(extracted.some((line) => line.includes('Head of Service'))).toBe(false);
    expect(extracted.some((line) => line.includes('normal place of work'))).toBe(false);
    expect(extracted.some((line) => line.includes('required standards'))).toBe(false);
  });
});

describe('a criterion the matcher cannot judge', () => {
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
    fact('skills.list', ['customer service', 'record keeping']),
    fact('preferences.location', ['Glasgow']),
  ];

  const job: ShadowJob = {
    id: '00000000-0000-4000-8000-0000000000aa',
    title: 'Delivery Support Officer',
    employer: 'Invented Council',
    description: 'An administrative post supporting service delivery.',
    location: 'Glasgow',
    salary: {
      minimumMinor: 2_800_000,
      maximumMinor: 3_000_000,
      currency: 'GBP',
      basis: 'annual_base',
      confidence: 0.95,
      sourceText: 'stated',
    },
    contractType: 'permanent',
    employmentTypes: ['full_time'],
    workPattern: 'full_time',
    closesAt: null,
    personSpecification: { status: 'read', text: wrappedProfile },
  };

  const result = shadowMatch(job, facts, defaultAgentConfig);

  it('surfaces the criteria rather than reporting none', () => {
    expect(result.requirements.length).toBeGreaterThanOrEqual(4);
    expect(result.criteria.visible).toBe(true);
  });

  it('blocks automatic progression when nothing could be checked', () => {
    const judged = result.requirements.filter((r) => r.outcome !== 'unknown');
    if (judged.length === 0) {
      expect(result.decision.autoBlockers).toContain('criteria_not_evidenced');
    }
  });

  /**
   * The point of the change: an unknown criterion already blocks progression, so counting it as
   * uncovered too drove real vacancies to a score of 15 for the agent's blind spot rather than the
   * applicant's unsuitability.
   */
  it('does not collapse the score because the agent could not evidence the criteria', () => {
    expect(result.decision.score).toBeGreaterThan(30);
  });

  it('is never auto-applied for', () => {
    expect(result.decision.action).not.toBe('auto_apply');
  });
});
