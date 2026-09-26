import {
  isApprovedRealSiteUrl,
  realSiteAdapterSchema,
  type FieldIntent,
  type RealSiteAdapter,
  type RealSiteExecutionMode,
} from '@job-agent/browser-core';

export const MYJOBSCOTLAND_ADAPTER_ID = 'myjobscotland-talentlink';
export const MYJOBSCOTLAND_ADAPTER_VERSION = '0.1.0';

/**
 * The hosts a MyJobScotland application is served from. MyJobScotland publishes the advert;
 * the application itself runs on Lumesse/TalentLink, and the disclaimer warns that some councils
 * redirect to their own minisite. Only these are approved, and only over HTTPS.
 *
 * A council minisite on another domain is deliberately absent: it would need its own review.
 */
export const MYJOBSCOTLAND_APPROVED_DOMAINS = [
  'myjobscotland.gov.uk',
  'emea3.recruitmentplatform.com',
  'emea5.recruitmentplatform.com',
] as const;

/**
 * The observed shape of a TalentLink application, recorded as structure only: no personal value,
 * no session data and no credential was captured while describing it.
 *
 * Every step that carries a declaration, a consent tick, equality monitoring or the final send is
 * marked `humanOnly`, so the agent observes it and hands it straight over. There is no submit step
 * at all: `RealSiteAdapter` cannot express one.
 */
export function myJobScotlandAdapter(
  executionMode: RealSiteExecutionMode = 'disabled',
): RealSiteAdapter {
  return realSiteAdapterSchema.parse({
    id: MYJOBSCOTLAND_ADAPTER_ID,
    version: MYJOBSCOTLAND_ADAPTER_VERSION,
    providerName: 'MyJobScotland (Lumesse TalentLink)',
    approvedDomains: [...MYJOBSCOTLAND_APPROVED_DOMAINS],
    executionMode,
    allowsSubmit: false,
    isFakeTarget: false,
    requiresUserAuthentication: true,
    steps: [
      {
        id: 'signin',
        description: 'Candidate sign-in, registration and any verification challenge',
        humanOnly: true,
      },
      {
        id: 'personal_details',
        description: 'Name, contact details and address',
        humanOnly: false,
        nextSelector: '#next',
      },
      {
        id: 'employment_history',
        description: 'Employment history, repeated per role',
        humanOnly: false,
        nextSelector: '#next',
      },
      {
        id: 'education',
        description: 'Education and qualifications',
        humanOnly: false,
        nextSelector: '#next',
      },
      {
        id: 'documents',
        description: 'CV and supporting document upload',
        humanOnly: false,
        nextSelector: '#next',
      },
      {
        id: 'supporting_statement',
        description: 'Supporting statement against the person specification',
        humanOnly: false,
        nextSelector: '#next',
      },
      {
        id: 'eligibility',
        description: 'Right to work, disclosure and driving-licence questions',
        humanOnly: true,
      },
      {
        id: 'equality_monitoring',
        description: 'Equality and diversity monitoring',
        humanOnly: true,
      },
      {
        id: 'declarations',
        description: 'Declarations, consent and the final send',
        humanOnly: true,
      },
    ],
  });
}

/**
 * Label patterns observed on TalentLink forms, mapped to canonical intents.
 *
 * Matching is deliberately narrow. A label that does not match confidently stays `unknown`, which
 * makes the validator refuse the fill and the workflow ask the user. Guessing from a loose keyword
 * overlap is what produces invented answers, so it is not done here.
 */
const labelPatterns: ReadonlyArray<{ intent: FieldIntent; patterns: readonly RegExp[] }> = [
  { intent: 'identity.first_name', patterns: [/^\s*(first|fore)\s*name\s*\*?\s*$/i] },
  { intent: 'identity.last_name', patterns: [/^\s*(last|sur)\s*name\s*\*?\s*$/i] },
  { intent: 'contact.email', patterns: [/^\s*e-?mail(\s*address)?\s*\*?\s*$/i] },
  {
    intent: 'contact.phone',
    patterns: [/^\s*(mobile|telephone|phone|contact)\s*(number|no\.?)?\s*\*?\s*$/i],
  },
  { intent: 'employment.employer', patterns: [/^\s*(employer|organisation|company)\s*\*?\s*$/i] },
  { intent: 'employment.job_title', patterns: [/^\s*(job\s*title|position|role)\s*\*?\s*$/i] },
  {
    intent: 'employment.start_date',
    patterns: [/^\s*(date\s*)?from\s*\*?\s*$/i, /^\s*start\s*date\s*\*?\s*$/i],
  },
  {
    intent: 'employment.end_date',
    patterns: [/^\s*(date\s*)?to\s*\*?\s*$/i, /^\s*end\s*date\s*\*?\s*$/i],
  },
  {
    intent: 'employment.duties',
    patterns: [/^\s*(main\s*)?(duties|responsibilities)(\s*and\s*responsibilities)?\s*\*?\s*$/i],
  },
  {
    intent: 'employment.leaving_reason',
    patterns: [/^\s*reason\s*for\s*leaving\s*\*?\s*$/i],
  },
  {
    intent: 'education.institution',
    patterns: [/^\s*(school|college|university|institution)\s*\*?\s*$/i],
  },
  {
    intent: 'education.qualification',
    patterns: [/^\s*(qualification|subject|course)(\s*name)?\s*\*?\s*$/i],
  },
  { intent: 'education.grade', patterns: [/^\s*(grade|result|award)\s*\*?\s*$/i] },
  { intent: 'education.year', patterns: [/^\s*(year|date)\s*(obtained|awarded)\s*\*?\s*$/i] },
  { intent: 'documents.cv', patterns: [/\bcv\b/i, /curriculum\s*vitae/i, /upload.*r[ée]sum[ée]/i] },
  {
    intent: 'statement.supporting',
    patterns: [/supporting\s*(statement|information)/i, /why.*suitable.*(post|role)/i],
  },
  {
    intent: 'sensitive.disability',
    patterns: [/disab(ility|led)/i, /reasonable\s*adjustment/i, /long[-\s]*term\s*health/i],
  },
  {
    intent: 'sensitive.criminal_record',
    patterns: [/convict/i, /criminal\s*record/i, /\bpvg\b/i, /disclosure\s*scotland/i],
  },
  {
    intent: 'sensitive.diversity',
    patterns: [
      /ethnic/i,
      /gender|sex\b/i,
      /sexual\s*orientation/i,
      /religio/i,
      /marital\s*status/i,
      /equal\s*opportunit/i,
    ],
  },
  {
    intent: 'declaration.truth',
    patterns: [/declar/i, /\bi\s*confirm\b/i, /information.*true.*complete/i, /consent/i],
  },
];

/**
 * Maps one observed label to an intent, or `unknown`.
 *
 * Sensitive and declaration patterns are checked first: if a label looks at all like a diversity,
 * disclosure or declaration question it must land on a human-only intent, even when it also
 * resembles something fillable.
 */
export function mapMyJobScotlandLabel(label: string): FieldIntent {
  const text = label.replace(/\s+/g, ' ').trim();
  if (text === '') return 'unknown';
  const sensitiveFirst = [...labelPatterns].sort((left, right) => {
    const weight = (intent: FieldIntent): number =>
      intent.startsWith('sensitive.') || intent.startsWith('declaration.') ? 0 : 1;
    return weight(left.intent) - weight(right.intent);
  });
  for (const { intent, patterns } of sensitiveFirst) {
    if (patterns.some((pattern) => pattern.test(text))) return intent;
  }
  return 'unknown';
}

/**
 * The reviewed real-site adapters, looked up by the address the advert points at.
 *
 * A domain with no entry here returns null, and the preparation view then reports that there is no
 * reviewed adapter rather than improvising one. Adding a domain is a review, not a code tweak.
 */
export function realSiteAdapterForUrl(
  url: string | null,
  executionMode: RealSiteExecutionMode = 'disabled',
): RealSiteAdapter | null {
  if (url === null) return null;
  const candidate = myJobScotlandAdapter(executionMode);
  return isApprovedRealSiteUrl(url, candidate.approvedDomains) ? candidate : null;
}
