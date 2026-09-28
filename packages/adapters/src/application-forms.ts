import {
  isApprovedRealSiteUrl,
  type ApplicationFormOutline,
  type ApplicationQuestionTemplate,
  type ApplicationQuestionTemplateEntry,
} from '@job-agent/browser-core';

import { myJobScotlandAdapter } from './myjobscotland.js';

/**
 * The shape of a UK public-sector application, for a person to work through by hand.
 *
 * This describes a form; it authorises nothing. There is no domain, no execution mode and no route
 * that drives it. It exists so the local preparation screen can show which boxes are coming, in the
 * order they come, with the wording the form uses — which is what makes a copy-by-hand handoff
 * usable rather than a wall of fact keys.
 *
 * The step ids match `myJobScotlandAdapter()`, so one question set describes both the reviewed
 * MyJobScotland flow and an unreviewed employer's form. What differs is only what the person is
 * told they are looking at.
 */

const steps: ApplicationFormOutline['steps'] = [
  {
    id: 'signin',
    description: 'Candidate sign-in, registration and any verification challenge',
    humanOnly: true,
  },
  { id: 'personal_details', description: 'Name, contact details and address', humanOnly: false },
  {
    id: 'employment_history',
    description: 'Employment history, repeated per role',
    humanOnly: false,
  },
  { id: 'education', description: 'Education and qualifications', humanOnly: false },
  { id: 'documents', description: 'CV and supporting document upload', humanOnly: false },
  {
    id: 'supporting_statement',
    description: 'Supporting statement against the person specification',
    humanOnly: false,
  },
  {
    id: 'eligibility',
    description: 'Right to work, disclosure and driving-licence questions',
    humanOnly: true,
  },
  { id: 'equality_monitoring', description: 'Equality and diversity monitoring', humanOnly: true },
  { id: 'declarations', description: 'Declarations, consent and the final send', humanOnly: true },
];

export const GENERIC_APPLICATION_FORM_ID = 'manual-employer-application';
export const APPLICATION_FORM_VERSION = '1.0.0';

/**
 * The reviewed MyJobScotland/TalentLink flow, described as a form outline.
 *
 * Taken from the adapter's own steps rather than restated, so the two cannot drift. The adapter is
 * read at its shipped execution mode, which is disabled; nothing here switches anything on.
 */
export function myJobScotlandApplicationForm(): ApplicationFormOutline {
  const adapter = myJobScotlandAdapter();
  return {
    id: adapter.id,
    version: adapter.version,
    providerName: adapter.providerName,
    steps: adapter.steps.map((step) => ({
      id: step.id,
      description: step.description,
      humanOnly: step.humanOnly,
    })),
  };
}

/**
 * A generic employer application, for a job whose site has no reviewed adapter.
 *
 * The step order and the human-only steps are the ones a UK public-sector application almost always
 * has. The person is told plainly that this is a general outline and that their form may differ, so
 * a missing box is read as "check the form" rather than "the agent said there was nothing there".
 */
export function genericApplicationForm(): ApplicationFormOutline {
  return {
    id: GENERIC_APPLICATION_FORM_ID,
    version: APPLICATION_FORM_VERSION,
    providerName: 'Employer application form (you fill this in yourself)',
    steps,
  };
}

const entries: readonly ApplicationQuestionTemplateEntry[] = [
  {
    stepId: 'signin',
    label: 'Candidate sign-in or registration',
    intent: 'unknown',
    required: true,
    guidance:
      'Sign in or register yourself and clear any verification step. The agent never handles a login, a one-time code or a CAPTCHA.',
  },
  {
    stepId: 'personal_details',
    label: 'First name',
    intent: 'identity.first_name',
    required: true,
  },
  { stepId: 'personal_details', label: 'Surname', intent: 'identity.last_name', required: true },
  { stepId: 'personal_details', label: 'Email address', intent: 'contact.email', required: true },
  {
    stepId: 'personal_details',
    label: 'Telephone number',
    intent: 'contact.phone',
    required: true,
  },
  {
    stepId: 'employment_history',
    label: 'Employer',
    intent: 'employment.employer',
    required: true,
    repeatsWith: 'employment',
  },
  {
    stepId: 'employment_history',
    label: 'Job title',
    intent: 'employment.job_title',
    required: true,
    repeatsWith: 'employment',
  },
  {
    stepId: 'employment_history',
    label: 'Date from',
    intent: 'employment.start_date',
    required: true,
    repeatsWith: 'employment',
  },
  {
    stepId: 'employment_history',
    label: 'Date to',
    intent: 'employment.end_date',
    required: false,
    repeatsWith: 'employment',
  },
  {
    stepId: 'employment_history',
    label: 'Main duties and responsibilities',
    intent: 'employment.duties',
    required: true,
    repeatsWith: 'employment',
  },
  {
    stepId: 'employment_history',
    label: 'Reason for leaving',
    intent: 'employment.leaving_reason',
    required: false,
    repeatsWith: 'employment',
  },
  {
    stepId: 'education',
    label: 'School, college or university',
    intent: 'education.institution',
    required: true,
    repeatsWith: 'education',
  },
  {
    stepId: 'education',
    label: 'Qualification',
    intent: 'education.qualification',
    required: true,
    repeatsWith: 'education',
  },
  {
    stepId: 'education',
    label: 'Grade',
    intent: 'education.grade',
    required: false,
    repeatsWith: 'education',
  },
  {
    stepId: 'education',
    label: 'Year obtained',
    intent: 'education.year',
    required: false,
    repeatsWith: 'education',
  },
  { stepId: 'documents', label: 'Upload your CV', intent: 'documents.cv', required: true },
  {
    stepId: 'supporting_statement',
    label: 'Supporting statement',
    intent: 'statement.supporting',
    required: true,
    guidance:
      'Write this yourself against the person specification. The agent will not draft claims about your experience, and will not present another application’s statement as though it were written for this post.',
  },
  {
    stepId: 'eligibility',
    label: 'Do you have the right to work in the UK?',
    intent: 'work_authorisation.status',
    required: true,
  },
  {
    stepId: 'eligibility',
    label: 'Disclosure Scotland, PVG or criminal-record questions',
    intent: 'sensitive.criminal_record',
    required: true,
  },
  {
    stepId: 'equality_monitoring',
    label: 'Ethnicity, gender, sexual orientation, religion and marital status',
    intent: 'sensitive.diversity',
    required: false,
  },
  {
    stepId: 'equality_monitoring',
    label: 'Disability and reasonable adjustments',
    intent: 'sensitive.disability',
    required: false,
  },
  {
    stepId: 'declarations',
    label: 'Declaration that the information given is true and complete',
    intent: 'declaration.truth',
    required: true,
  },
  {
    stepId: 'declarations',
    label: 'Consent to the employer processing your application',
    intent: 'consent.data_processing',
    required: true,
  },
];

/** The question set for one form outline. Bound to the outline's id and version by the builder. */
export function applicationQuestionTemplate(
  form: ApplicationFormOutline,
): ApplicationQuestionTemplate {
  return { formId: form.id, formVersion: form.version, entries };
}

/**
 * The form outline and question set for one application address.
 *
 * A reviewed adapter covers the address, or it does not; either way the person gets a usable pack,
 * and is told which of the two they are reading. No address is contacted here.
 */
export function applicationFormForUrl(url: string | null): {
  form: ApplicationFormOutline;
  template: ApplicationQuestionTemplate;
  reviewedForThisSite: boolean;
} {
  const reviewed =
    url !== null && isApprovedRealSiteUrl(url, myJobScotlandAdapter().approvedDomains);
  const form = reviewed ? myJobScotlandApplicationForm() : genericApplicationForm();
  return { form, template: applicationQuestionTemplate(form), reviewedForThisSite: reviewed };
}
