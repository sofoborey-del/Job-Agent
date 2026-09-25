import type { FakeSession } from './state.js';

export type ControlType =
  'text' | 'email' | 'tel' | 'number' | 'textarea' | 'select' | 'radio' | 'checkbox' | 'file';

export type FormControl = {
  name: string;
  label: string;
  type: ControlType;
  required?: boolean;
  options?: string[];
  maxLength?: number;
  minLength?: number;
  conditionalOn?: { field: string; value: string };
  hint?: string;
};

export const stepTitles: Record<string, string> = {
  details: 'Your details',
  history: 'Employment and education',
  documents: 'Your CV',
  questions: 'Monitoring questions',
  checks: 'Security checks',
  declarations: 'Declarations',
  review: 'Check your answers',
};

function employmentRow(index: number): FormControl[] {
  const suffix = `_${String(index)}`;
  return [
    {
      name: `employment_employer${suffix}`,
      label: 'Employer',
      type: 'text',
      required: index === 0,
    },
    {
      name: `employment_job_title${suffix}`,
      label: 'Job title',
      type: 'text',
      required: index === 0,
    },
    { name: `employment_start${suffix}`, label: 'Start date', type: 'text', required: index === 0 },
    { name: `employment_end${suffix}`, label: 'End date', type: 'text' },
    {
      name: `employment_duties${suffix}`,
      label: 'Main duties and responsibilities',
      type: 'textarea',
      maxLength: 1200,
    },
  ];
}

function educationRow(index: number): FormControl[] {
  const suffix = `_${String(index)}`;
  return [
    {
      name: `education_institution${suffix}`,
      label: 'School, college or university',
      type: 'text',
      required: index === 0,
    },
    {
      name: `education_qualification${suffix}`,
      label: 'Qualification or degree',
      type: 'text',
      required: index === 0,
    },
    { name: `education_grade${suffix}`, label: 'Grade or classification', type: 'text' },
    { name: `education_year${suffix}`, label: 'Year awarded', type: 'text' },
  ];
}

export function controlsFor(
  stepId: string,
  session: FakeSession,
  extraReviewField: boolean,
): FormControl[] {
  switch (stepId) {
    case 'details':
      return [
        { name: 'first_name', label: 'First name', type: 'text', required: true, maxLength: 60 },
        { name: 'last_name', label: 'Last name', type: 'text', required: true, maxLength: 60 },
        { name: 'email', label: 'Email address', type: 'email', required: true },
        { name: 'phone', label: 'Telephone number', type: 'tel', required: true },
        {
          name: 'years_experience',
          label: 'Years of relevant experience',
          type: 'number',
          required: true,
        },
        {
          name: 'contract_preference',
          label: 'Contract type preference',
          type: 'select',
          required: true,
          options: ['Permanent', 'Fixed term', 'Temporary'],
        },
        {
          name: 'right_to_work',
          label: 'Right to work in the UK',
          type: 'radio',
          required: true,
          options: ['Yes', 'Sponsorship required'],
        },
        {
          name: 'visa_type',
          label: 'Visa type',
          type: 'text',
          required: true,
          conditionalOn: { field: 'right_to_work', value: 'Sponsorship required' },
        },
        { name: 'relocate', label: 'Willing to relocate for this role', type: 'checkbox' },
        {
          name: 'supporting_statement',
          label: 'Supporting statement',
          type: 'textarea',
          required: true,
          maxLength: 2000,
          minLength: 50,
          hint: 'Tell us why you are applying. At least 50 characters.',
        },
        {
          name: 'favourite_colour',
          label: 'Which colour best describes your working style?',
          type: 'text',
          hint: 'An invented question with no equivalent in any profile.',
        },
        {
          name: 'referral_code',
          label: 'Internal referral code, if you were given one',
          type: 'text',
        },
      ];
    case 'history':
      return [
        ...Array.from({ length: session.employmentRows }, (_, index) =>
          employmentRow(index),
        ).flat(),
        ...Array.from({ length: session.educationRows }, (_, index) => educationRow(index)).flat(),
      ];
    case 'documents':
      return [{ name: 'cv', label: 'Upload your CV', type: 'file', required: true }];
    case 'questions':
      return [
        {
          name: 'disability',
          label: 'Do you consider yourself to have a disability?',
          type: 'radio',
          required: true,
          options: ['Yes', 'No', 'Prefer not to say'],
        },
        {
          name: 'criminal_record',
          label: 'Do you have any unspent criminal convictions?',
          type: 'radio',
          required: true,
          options: ['Yes', 'No'],
        },
        {
          name: 'ethnicity',
          label: 'Ethnic group, for diversity monitoring',
          type: 'select',
          required: true,
          options: ['Prefer not to say', 'Group A', 'Group B', 'Group C'],
        },
      ];
    case 'checks':
      return [
        {
          name: 'captcha_answer',
          label: 'CAPTCHA: type the characters shown in the image',
          type: 'text',
          required: true,
        },
        {
          name: 'mfa_code',
          label: 'Enter the one-time code we sent to your phone',
          type: 'text',
          required: true,
        },
        {
          name: 'assessment_started',
          label: 'I have completed the online situational judgement assessment',
          type: 'checkbox',
          required: true,
        },
      ];
    case 'declarations':
      return [
        {
          name: 'declaration',
          label: 'I declare that the information given is true and complete',
          type: 'checkbox',
          required: true,
        },
        {
          name: 'consent',
          label: 'I consent to my data being processed under the privacy notice',
          type: 'checkbox',
          required: true,
        },
      ];
    case 'review':
      return extraReviewField
        ? [
            {
              name: 'late_addition',
              label: 'New question added after you started: confirm you still wish to apply',
              type: 'checkbox',
              required: true,
            },
          ]
        : [];
    default:
      return [];
  }
}

export function visibleControls(
  stepId: string,
  session: FakeSession,
  extraReviewField: boolean,
): FormControl[] {
  return controlsFor(stepId, session, extraReviewField).filter((control) => {
    if (control.conditionalOn === undefined) return true;
    return session.values[control.conditionalOn.field] === control.conditionalOn.value;
  });
}

export function validateStep(
  stepId: string,
  session: FakeSession,
  submitted: Record<string, string>,
  files: Record<string, unknown>,
  extraReviewField: boolean,
): string[] {
  const errors: string[] = [];
  for (const control of controlsFor(stepId, session, extraReviewField)) {
    if (control.conditionalOn !== undefined) {
      const trigger =
        submitted[control.conditionalOn.field] ?? session.values[control.conditionalOn.field];
      if (trigger !== control.conditionalOn.value) continue;
    }
    const value = submitted[control.name] ?? '';
    if (control.type === 'file') {
      if (control.required === true && files[control.name] === undefined) {
        errors.push(`${control.label} is required.`);
      }
      continue;
    }
    if (control.type === 'checkbox') {
      if (control.required === true && value !== 'on')
        errors.push(`${control.label} must be ticked.`);
      continue;
    }
    if (control.required === true && value.trim() === '') {
      errors.push(`${control.label} is required.`);
      continue;
    }
    if (
      control.minLength !== undefined &&
      value.trim() !== '' &&
      value.length < control.minLength
    ) {
      errors.push(`${control.label} must be at least ${String(control.minLength)} characters.`);
    }
    if (control.maxLength !== undefined && value.length > control.maxLength) {
      errors.push(`${control.label} must be ${String(control.maxLength)} characters or fewer.`);
    }
    if (
      control.type === 'email' &&
      value.trim() !== '' &&
      !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value)
    ) {
      errors.push(`${control.label} must be a valid email address.`);
    }
    if (control.type === 'number' && value.trim() !== '' && !/^\d+$/.test(value.trim())) {
      errors.push(`${control.label} must be a whole number.`);
    }
    if (control.options !== undefined && value.trim() !== '' && !control.options.includes(value)) {
      errors.push(`${control.label} must be one of the options offered.`);
    }
  }
  return errors;
}
