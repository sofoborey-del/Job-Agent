import { describe, expect, it } from 'vitest';

import { buildApplicationAnswerPack, type AnswerPackItem } from '@job-agent/browser-core';
import type { KnowledgeFact } from '@job-agent/domain';

import {
  applicationFormForUrl,
  applicationQuestionTemplate,
  genericApplicationForm,
  myJobScotlandApplicationForm,
} from './application-forms.js';

/**
 * Every value here is invented. No real applicant value appears in this file.
 *
 * What these tests defend is the honesty of the pack, not its prettiness: a value must trace to a
 * verified fact, a row must exist in the profile before it is filled, and a human-only question must
 * stay empty however much the profile holds.
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
  fact('identity.legal_name', { given: 'Ada', family: 'Invented' }),
  fact('contact.email', 'ada.invented@example.invalid'),
  fact('contact.phone', '07700900123'),
  fact('employment.history', [
    {
      employer: 'Invented Trading Ltd',
      title: 'Customer Adviser',
      startDate: 'March 2021',
      endDate: 'August 2022',
      evidenceSummary: 'Handled customer enquiries and record keeping.',
    },
    {
      employer: 'Second Invented Employer',
      title: 'Service Assistant',
      startDate: 'January 2020',
      endDate: 'February 2021',
      evidenceSummary: 'Branch service duties.',
    },
  ]),
  fact('education.history', [
    {
      institution: 'Invented College',
      qualification: 'HNC Business',
      grade: 'Pass',
      endDate: '2015',
    },
  ]),
  fact('employment.leaving_reasons.first', {
    employer: 'Invented Trading Ltd',
    reasonForLeaving: 'Redundancy following over-recruitment',
  }),
  fact('work_authorisation.gb', { authorised: true }),
];

const approvedDocument = {
  documentId: '00000000-0000-4000-8000-0000000000cv',
  sha256: 'a'.repeat(64),
  filename: 'cv.pdf',
};

type PackInput = Parameters<typeof buildApplicationAnswerPack>[0];

function pack(
  facts: readonly KnowledgeFact<unknown>[] = profile,
  options: { reusableAnswers?: PackInput['reusableAnswers'] } = {},
) {
  const form = myJobScotlandApplicationForm();
  return buildApplicationAnswerPack({
    form,
    template: applicationQuestionTemplate(form),
    facts,
    approvedDocument,
    ...(options.reusableAnswers === undefined ? {} : { reusableAnswers: options.reusableAnswers }),
  });
}

function items(result: ReturnType<typeof pack>): AnswerPackItem[] {
  return result.sections.flatMap((section) => [...section.items]);
}

function item(result: ReturnType<typeof pack>, id: string): AnswerPackItem {
  const found = items(result).find((candidate) => candidate.id === id);
  if (found === undefined) throw new Error(`no item ${id}`);
  return found;
}

describe('the grounded answer pack', () => {
  it('answers what the profile holds, verbatim, with its evidence', () => {
    const result = pack();
    expect(item(result, 'personal_details.identity.first_name').value).toBe('Ada');
    expect(item(result, 'personal_details.identity.last_name').value).toBe('Invented');
    expect(item(result, 'personal_details.contact.email').value).toBe(
      'ada.invented@example.invalid',
    );
    const employer = item(result, 'employment_history.employment.employer.0');
    expect(employer.value).toBe('Invented Trading Ltd');
    expect(employer.source.kind).toBe('verified_fact');
    expect(employer.source.evidenceFactIds.length).toBeGreaterThan(0);
  });

  it('gives every ready answer a traceable source and never a bare claim', () => {
    for (const entry of items(pack()).filter((candidate) => candidate.status === 'ready')) {
      expect(entry.value).not.toBeNull();
      if (entry.source.kind === 'approved_document') {
        expect(entry.value).toBe('cv.pdf');
      } else {
        expect(entry.source.kind).toBe('verified_fact');
        expect(entry.source.evidenceFactIds.length).toBeGreaterThan(0);
      }
    }
  });

  it('opens exactly as many role and qualification rows as the profile records', () => {
    const result = pack();
    expect(result.summary.employmentRowsRecorded).toBe(2);
    expect(result.summary.educationRowsRecorded).toBe(1);
    expect(
      items(result).filter((c) => c.id.startsWith('employment_history.employment.employer')),
    ).toHaveLength(2);
    expect(
      items(result).filter((c) => c.id.startsWith('education.education.institution')),
    ).toHaveLength(1);
  });

  it('asks rather than guesses when a detail is not recorded for a row', () => {
    // Only the first employer has a recorded reason for leaving; the second must be a question.
    expect(item(pack(), 'employment_history.employment.leaving_reason.0').value).toBe(
      'Redundancy following over-recruitment',
    );
    const second = item(pack(), 'employment_history.employment.leaving_reason.1');
    expect(second.status).toBe('needs_you');
    expect(second.value).toBeNull();
    expect(second.source.kind).toBe('none');
  });

  it('never attaches a reason for leaving to an employer it does not name', () => {
    const swapped = profile.map((entry) =>
      entry.key === 'employment.leaving_reasons.first'
        ? fact('employment.leaving_reasons.first', {
            employer: 'Some Other Employer',
            reasonForLeaving: 'Redundancy following over-recruitment',
          })
        : entry,
    );
    expect(item(pack(swapped), 'employment_history.employment.leaving_reason.0').status).toBe(
      'needs_you',
    );
  });

  it('leaves right to work, disclosure, equality monitoring and declarations empty', () => {
    const result = pack();
    for (const id of [
      'eligibility.work_authorisation.status',
      'eligibility.sensitive.criminal_record',
      'equality_monitoring.sensitive.diversity',
      'equality_monitoring.sensitive.disability',
      'declarations.declaration.truth',
      'declarations.consent.data_processing',
      'signin.unknown',
    ]) {
      const entry = item(result, id);
      expect(entry.status).toBe('human_only');
      expect(entry.value).toBeNull();
      expect(entry.source.evidenceFactIds).toHaveLength(0);
    }
  });

  it('will not compose a supporting statement', () => {
    const entry = item(pack(), 'supporting_statement.statement.supporting');
    expect(entry.status).toBe('needs_you');
    expect(entry.value).toBeNull();
  });

  it('names the approved CV without carrying the document', () => {
    const result = pack();
    expect(result.cvAttachment).toEqual(approvedDocument);
    expect(JSON.stringify(result)).not.toContain('contentBase64');
    // The upload question itself is the person's action, so it carries no value to copy.
    expect(item(result, 'documents.documents.cv').value).toBe('cv.pdf');
  });

  it('refuses a fact the knowledge base does not release for application use', () => {
    const restricted = profile.map((entry) =>
      entry.key === 'contact.email'
        ? fact('contact.email', 'ada.invented@example.invalid', {
            usePolicy: 'never_auto_fill',
          })
        : entry,
    );
    const entry = item(pack(restricted), 'personal_details.contact.email');
    expect(entry.status).toBe('needs_you');
    expect(entry.value).toBeNull();
  });

  it('shows no reusable answer unless the person asked for that topic', () => {
    expect(pack().reusableAnswers).toHaveLength(0);
    const chosen = pack(profile, {
      reusableAnswers: [
        { topic: 'ethnicity', label: 'Ethnicity', answer: 'Prefer not to say', sensitive: true },
      ],
    });
    expect(chosen.reusableAnswers).toHaveLength(1);
    expect(chosen.reusableAnswers[0]?.note).toContain('optional');
  });

  it('keeps reusable answers and human-only questions off the copy-all clipboard', () => {
    const result = pack(profile, {
      reusableAnswers: [
        {
          topic: 'ethnicity',
          label: 'Ethnicity',
          answer: 'Invented ethnicity answer',
          sensitive: true,
        },
      ],
    });
    expect(result.clipboardText).toContain('Invented Trading Ltd');
    expect(result.clipboardText).not.toContain('Invented ethnicity answer');
    expect(result.clipboardText).not.toContain('Declaration');
    expect(result.clipboardText).not.toContain('right to work');
  });

  it('states plainly when there is no history to work from', () => {
    const bare = [fact('identity.legal_name', { given: 'Ada', family: 'Invented' })];
    const result = pack(bare);
    expect(result.summary.employmentRowsRecorded).toBe(0);
    expect(result.summary.educationRowsRecorded).toBe(0);
    expect(result.warnings.some((warning) => warning.includes('No employment history'))).toBe(true);
    // The role boxes are still listed, so an empty history cannot read as "nothing to do".
    expect(item(result, 'employment_history.employment.employer.0').status).toBe('needs_you');
  });

  it('warns about date precision, because a form may demand a day the CV never carried', () => {
    expect(pack().warnings.some((warning) => warning.includes('precision'))).toBe(true);
  });

  it('never claims anything was filled in', () => {
    expect(pack().prefillPerformed).toBe(false);
  });

  it('refuses a question set written for a different form', () => {
    expect(() =>
      buildApplicationAnswerPack({
        form: myJobScotlandApplicationForm(),
        template: applicationQuestionTemplate(genericApplicationForm()),
        facts: profile,
      }),
    ).toThrow(/does not match/);
  });
});

describe('choosing the form outline for an application address', () => {
  it('uses the reviewed MyJobScotland outline for a MyJobScotland address', () => {
    const chosen = applicationFormForUrl('https://www.myjobscotland.gov.uk/councils/x/jobs/1');
    expect(chosen.reviewedForThisSite).toBe(true);
    expect(chosen.form.id).toBe(myJobScotlandApplicationForm().id);
  });

  it('falls back to a general outline for any other address, and says so', () => {
    for (const url of [
      'https://careers.example.com/apply',
      'http://www.myjobscotland.gov.uk/jobs/1',
      'https://myjobscotland.gov.uk.phishing.example/jobs/1',
      null,
    ]) {
      const chosen = applicationFormForUrl(url);
      expect(chosen.reviewedForThisSite).toBe(false);
      expect(chosen.form.id).toBe(genericApplicationForm().id);
    }
  });

  it('keeps the same human-only steps on both outlines', () => {
    const humanOnly = (steps: { id: string; humanOnly: boolean }[]) =>
      steps.filter((step) => step.humanOnly).map((step) => step.id);
    expect(humanOnly([...genericApplicationForm().steps])).toEqual(
      humanOnly([...myJobScotlandApplicationForm().steps]),
    );
  });
});
