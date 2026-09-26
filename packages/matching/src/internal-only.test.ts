import { describe, expect, it } from 'vitest';

import { defaultAgentConfig } from '@job-agent/config';
import type { KnowledgeFact } from '@job-agent/domain';

import { decideMatch } from './index.js';
import {
  detectInternalOnlyRestriction,
  isEligibilityRestrictionSentence,
} from './internal-only.js';
import { shadowMatch } from './shadow.js';

const config = defaultAgentConfig;

/** The advert that was wrongly shortlisted, in the form the restriction was written. */
const businessSupportOfficer = [
  'Business Support Officer (QA)',
  'This post is open only to current employees of Jobs and Business Glasgow and to ILM participants.',
  'You must have experience of administrative support in a busy office.',
  'You must be able to use Microsoft Office and manage records accurately.',
].join('\n');

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

describe('detecting an advert that is closed to external applicants', () => {
  it('detects the restriction that produced a wrong shortlist', () => {
    const detection = detectInternalOnlyRestriction(businessSupportOfficer);
    expect(detection.status).toBe('restricted');
    expect(detection.matchedSentences.join(' ')).toContain('ILM participants');
  });

  it.each([
    'This vacancy is open only to existing staff.',
    'Internal applicants only.',
    'This role is not open to external applicants.',
    'External applicants will not be considered at this stage.',
    'The post is ring-fenced to employees at risk of redundancy.',
    'Applications are invited from redeployment candidates only.',
  ])('treats %j as restricted', (text) => {
    expect(detectInternalOnlyRestriction(text).status).toBe('restricted');
  });

  it.each([
    'We welcome applications from everyone in our community.',
    'This vacancy is open to both internal and external applicants.',
    'You must have experience of administrative support in a busy office.',
    'The successful candidate will support internal teams across the council.',
  ])('leaves %j open', (text) => {
    expect(detectInternalOnlyRestriction(text).status).toBe('open');
  });

  it('will not call an advert open when it says both things', () => {
    const detection = detectInternalOnlyRestriction(
      'This vacancy is open to both internal and external applicants. Internal applicants only.',
    );
    expect(detection.status).toBe('unclear');
  });

  it('reads the linked criteria document as well as the advert page', () => {
    const detection = detectInternalOnlyRestriction(
      'A varied administrative role.',
      'Eligibility: this post is open only to current employees of the council.',
    );
    expect(detection.status).toBe('restricted');
  });

  it('flags a secondment as unclear rather than guessing', () => {
    expect(detectInternalOnlyRestriction('This is a secondment opportunity.').status).toBe(
      'unclear',
    );
  });
});

describe('the restriction gate', () => {
  const base = {
    dimensions: {
      mandatoryCoverage: 1,
      relevantSkills: 1,
      relevantExperience: 1,
      locationFit: 1,
      compensationQuality: 1,
      otherPreferences: 1,
    },
    preferredCriteriaNotMet: 0,
    weakEvidenceCount: 0,
    evidenceCoverage: 0.9,
    decisionConfidence: 0.9,
    requirements: [],
    mandatoryRequirementIds: [],
    salary: {
      basis: 'annual_base' as const,
      minimum: { amountMinor: 3_000_000, currency: 'GBP' as const },
      maximum: { amountMinor: 3_500_000, currency: 'GBP' as const },
      confidence: 1,
      sourceText: '30,000 to 35,000',
    },
    locationCompatible: true,
    contractCompatible: true,
    workAuthorisationCompatible: true as const,
    excluded: false,
    duplicateApplication: false,
    jobOpen: true,
    sitePolicy: 'prefill_only' as const,
    dailyAutoSlotAvailable: false,
    answersComplete: false,
    humanOnlyStepPresent: true,
  };

  it('rejects a restricted advert outright, however well it otherwise scores', () => {
    const decision = decideMatch({ ...base, internalOnly: 'restricted' }, config);
    expect(decision.action).toBe('reject');
    expect(decision.hardRejectReasons).toContain('restricted_to_internal_candidates');
  });

  it('blocks automatic progression when eligibility is unclear', () => {
    const decision = decideMatch({ ...base, internalOnly: 'unclear' }, config);
    expect(decision.autoBlockers).toContain('eligibility_restriction_unclear');
  });

  it('does nothing to an advert that is open', () => {
    const decision = decideMatch({ ...base, internalOnly: 'open' }, config);
    expect(decision.hardRejectReasons).not.toContain('restricted_to_internal_candidates');
    expect(decision.autoBlockers).not.toContain('eligibility_restriction_unclear');
  });
});

describe('a restriction cannot be satisfied by keyword overlap', () => {
  it('never turns the restriction sentence into a matchable requirement', () => {
    expect(
      isEligibilityRestrictionSentence(
        'This post is open only to current employees of Jobs and Business Glasgow and to ILM participants.',
      ),
    ).toBe(true);
  });

  it('rejects the advert even when the profile is full of matching words', () => {
    // Every word in the restriction appears somewhere in this profile. Under the old behaviour
    // that overlap was enough to mark the sentence met; it must not be now.
    const facts = [
      fact('skills.list', ['employee engagement', 'participant support', 'quality assurance']),
      fact('employment.history', [
        {
          employer: 'Jobs and Business Glasgow partner organisation',
          title: 'Business Support Officer',
          startDate: '2019-01',
          endDate: '2021-01',
          evidenceSummary: 'Administrative support, records, Microsoft Office, ILM participants.',
        },
      ]),
      fact('preferences.target_roles', ['Business Support Officer']),
      fact('preferences.location', ['Glasgow']),
    ];

    const result = shadowMatch(
      {
        id: '00000000-0000-4000-8000-00000000abcd',
        title: 'Business Support Officer (QA)',
        employer: 'Jobs and Business Glasgow',
        description: businessSupportOfficer,
        location: 'Glasgow',
        salary: {
          minimumMinor: 2_800_000,
          maximumMinor: 3_000_000,
          currency: 'GBP',
          basis: 'annual_base',
          confidence: 1,
          sourceText: '28,000 to 30,000',
        },
        contractType: 'permanent',
        employmentTypes: ['full_time'],
        workPattern: 'full_time',
        closesAt: null,
      },
      facts,
      config,
    );

    expect(result.eligibility.status).toBe('restricted');
    expect(result.decision.action).toBe('reject');
    expect(result.decision.hardRejectReasons).toContain('restricted_to_internal_candidates');
    expect(result.requirements.map((requirement) => requirement.text).join(' ')).not.toContain(
      'ILM participants',
    );
  });
});
