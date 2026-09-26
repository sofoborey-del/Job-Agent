import { describe, expect, it } from 'vitest';

import type { KnowledgeFact } from '@job-agent/domain';

import { resolveRealSiteAnswer } from './real-site-resolver.js';

/**
 * These use the structure a real profile stores, with invented values. No real applicant value
 * appears in this file.
 */

let counter = 0;
function fact(
  key: string,
  value: unknown,
  overrides: Partial<KnowledgeFact<unknown>> = {},
): KnowledgeFact<unknown> {
  counter += 1;
  return {
    id: `00000000-0000-4000-8000-${String(counter).padStart(12, '0')}`,
    key,
    value,
    status: 'verified',
    source: 'user',
    sensitivity: 'normal',
    usePolicy: 'auto_fill',
    allowedPurposes: ['matching', 'application'],
    version: 1,
    ...overrides,
  };
}

const profile: KnowledgeFact<unknown>[] = [
  fact('identity.legal_name', { given: 'Ada', family: 'Invented', preferred: 'Ada' }),
  fact('contact.email', 'ada.invented@example.invalid'),
  fact('contact.phone', '07700900123'),
  fact('employment.history', [
    {
      employer: 'Strike',
      title: 'Customer Adviser',
      startDate: '2021-03',
      endDate: '2022-08',
      evidenceSummary: 'Handled customer enquiries and record keeping.',
    },
    {
      employer: 'Virgin Money',
      title: 'Service Assistant',
      startDate: '2020-01',
      endDate: '2021-02',
      evidenceSummary: 'Branch service duties.',
    },
  ]),
  fact('education.history', [
    {
      institution: 'Invented College',
      qualification: 'HNC Business',
      field: 'Business',
      grade: 'Pass',
      startDate: '2014-09',
      endDate: '2015-06',
    },
  ]),
  fact('employment.leaving_reasons.strike', {
    employer: 'Strike',
    reasonForLeaving: 'Redundancy following over-recruitment',
  }),
  fact('employment.leaving_reasons.virgin_money', {
    employer: 'Virgin Money',
    reasonForLeaving: 'Temporary contract ended',
    contractType: 'temporary',
  }),
  fact('work_authorisation.gb', {
    authorised: true,
    restrictions: [],
    sponsorshipRequiredNow: false,
    sponsorshipRequiredFuture: false,
  }),
];

describe('grounding an answer in the real profile structure', () => {
  it('reads the given and family name from the recorded legal name', () => {
    expect(resolveRealSiteAnswer({ intent: 'identity.first_name', facts: profile })).toMatchObject({
      status: 'resolved',
      value: 'Ada',
      source: 'verified_fact',
    });
    expect(resolveRealSiteAnswer({ intent: 'identity.last_name', facts: profile })).toMatchObject({
      status: 'resolved',
      value: 'Invented',
    });
  });

  it('cites the fact it used as evidence', () => {
    const answer = resolveRealSiteAnswer({ intent: 'contact.email', facts: profile });
    expect(answer.status).toBe('resolved');
    if (answer.status !== 'resolved') return;
    expect(answer.evidenceFactIds).toHaveLength(1);
  });

  it('fills each employment row from the matching recorded role', () => {
    expect(
      resolveRealSiteAnswer({ intent: 'employment.employer', rowIndex: 1, facts: profile }),
    ).toMatchObject({ status: 'resolved', value: 'Virgin Money' });
    expect(
      resolveRealSiteAnswer({ intent: 'employment.job_title', rowIndex: 0, facts: profile }),
    ).toMatchObject({ status: 'resolved', value: 'Customer Adviser' });
  });

  it('asks rather than inventing a role the profile does not hold', () => {
    const answer = resolveRealSiteAnswer({
      intent: 'employment.employer',
      rowIndex: 5,
      facts: profile,
    });
    expect(answer.status).toBe('requires_user');
    if (answer.status !== 'requires_user') return;
    expect(answer.prompt).toContain('2 recorded role');
  });
});

describe('reasons for leaving', () => {
  it('attaches each reason to the employer that reason names', () => {
    expect(
      resolveRealSiteAnswer({ intent: 'employment.leaving_reason', rowIndex: 0, facts: profile }),
    ).toMatchObject({ status: 'resolved', value: 'Redundancy following over-recruitment' });
    expect(
      resolveRealSiteAnswer({ intent: 'employment.leaving_reason', rowIndex: 1, facts: profile }),
    ).toMatchObject({ status: 'resolved', value: 'Temporary contract ended' });
  });

  /** The failure that matters: a reason must never migrate to the wrong employer. */
  it('asks when no recorded reason names that employer', () => {
    const facts = [
      ...profile.filter((candidate) => !candidate.key.startsWith('employment.leaving_reasons.')),
      fact('employment.leaving_reasons.other', {
        employer: 'Somewhere Else Entirely',
        reasonForLeaving: 'Company dissolved',
      }),
    ];
    const answer = resolveRealSiteAnswer({
      intent: 'employment.leaving_reason',
      rowIndex: 0,
      facts,
    });
    expect(answer.status).toBe('requires_user');
  });

  it('matches an employer name written with different punctuation', () => {
    const facts = [
      ...profile,
      fact('employment.leaving_reasons.london_and_country', {
        employer: 'London & Country',
        reasonForLeaving: 'One-year fixed-term contract ended',
      }),
    ];
    const withRow = facts.map((candidate) =>
      candidate.key === 'employment.history'
        ? fact('employment.history', [
            {
              employer: 'London and Country',
              title: 'Adviser',
              startDate: '2019-01',
              endDate: '2020-01',
            },
          ])
        : candidate,
    );
    expect(
      resolveRealSiteAnswer({ intent: 'employment.leaving_reason', rowIndex: 0, facts: withRow }),
    ).toMatchObject({ status: 'resolved', value: 'One-year fixed-term contract ended' });
  });
});

describe('what it refuses to answer', () => {
  it('never writes a supporting statement', () => {
    const answer = resolveRealSiteAnswer({ intent: 'statement.supporting', facts: profile });
    expect(answer.status).toBe('requires_user');
    if (answer.status !== 'requires_user') return;
    expect(answer.prompt).toContain('yourself');
  });

  it.each([
    'sensitive.disability',
    'sensitive.criminal_record',
    'sensitive.diversity',
    'declaration.truth',
  ] as const)('leaves %s to the person', (intent) => {
    expect(resolveRealSiteAnswer({ intent, facts: profile }).status).toBe('requires_user');
  });

  it('asks when a detail is simply not recorded', () => {
    const facts = profile.map((candidate) =>
      candidate.key === 'employment.history'
        ? fact('employment.history', [{ employer: 'Strike', title: 'Customer Adviser' }])
        : candidate,
    );
    expect(
      resolveRealSiteAnswer({ intent: 'employment.start_date', rowIndex: 0, facts }).status,
    ).toBe('requires_user');
  });

  it('asks when the profile holds nothing at all', () => {
    expect(resolveRealSiteAnswer({ intent: 'contact.email', facts: [] }).status).toBe(
      'requires_user',
    );
  });

  it('will not use a fact that is not allowed for applications', () => {
    const facts = [
      fact('contact.email', 'ada.invented@example.invalid', { allowedPurposes: ['matching'] }),
    ];
    expect(resolveRealSiteAnswer({ intent: 'contact.email', facts }).status).toBe('requires_user');
  });

  it('will not use an unverified or expired fact', () => {
    const unverified = [fact('contact.phone', '07700900123', { status: 'unverified' })];
    expect(resolveRealSiteAnswer({ intent: 'contact.phone', facts: unverified }).status).toBe(
      'requires_user',
    );
    const expired = [
      fact('contact.phone', '07700900123', { expiresAt: '2020-01-01T00:00:00.000Z' }),
    ];
    expect(resolveRealSiteAnswer({ intent: 'contact.phone', facts: expired }).status).toBe(
      'requires_user',
    );
  });

  it('will not auto-fill a fact marked ask-each-time', () => {
    const facts = [fact('contact.phone', '07700900123', { usePolicy: 'ask_each_time' })];
    expect(resolveRealSiteAnswer({ intent: 'contact.phone', facts }).status).toBe('requires_user');
  });
});

describe('right to work', () => {
  it('answers yes only when nothing is conditional', () => {
    expect(
      resolveRealSiteAnswer({ intent: 'work_authorisation.status', facts: profile }),
    ).toMatchObject({ status: 'resolved', value: 'Yes' });
  });

  it.each([
    { restrictions: ['student visa hours'], sponsorshipRequiredNow: false },
    { restrictions: [], sponsorshipRequiredNow: true },
    { restrictions: [], sponsorshipRequiredNow: false, sponsorshipRequiredFuture: true },
    { authorised: false, restrictions: [] },
  ])('hands a conditional case to the person: %j', (shape) => {
    const facts = [fact('work_authorisation.gb', { authorised: true, ...shape })];
    expect(resolveRealSiteAnswer({ intent: 'work_authorisation.status', facts }).status).toBe(
      'requires_user',
    );
  });
});

describe('the CV', () => {
  it('uses the approved document when there is one', () => {
    const answer = resolveRealSiteAnswer({
      intent: 'documents.cv',
      facts: profile,
      approvedDocument: { documentId: 'd', sha256: 'f'.repeat(64), filename: 'cv.pdf' },
    });
    expect(answer).toMatchObject({ status: 'resolved', source: 'approved_document' });
  });

  it('asks when no approved CV exists', () => {
    expect(resolveRealSiteAnswer({ intent: 'documents.cv', facts: profile }).status).toBe(
      'requires_user',
    );
  });
});
