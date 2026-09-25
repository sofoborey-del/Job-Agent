import { z } from 'zod';

export const controlTypes = [
  'text',
  'email',
  'tel',
  'number',
  'textarea',
  'select',
  'radio',
  'checkbox',
  'file',
  'button',
] as const;
export type ControlType = (typeof controlTypes)[number];

/**
 * Canonical intents the mapper may assign. Anything the mapper cannot place with confidence stays
 * `unknown`, which forces a question rather than a guess.
 */
export const fieldIntents = [
  'identity.first_name',
  'identity.last_name',
  'contact.email',
  'contact.phone',
  'experience.years',
  'preferences.contract_type',
  'work_authorisation.status',
  'work_authorisation.visa_type',
  'preferences.relocation',
  'statement.supporting',
  'employment.employer',
  'employment.job_title',
  'employment.start_date',
  'employment.end_date',
  'employment.duties',
  'education.institution',
  'education.qualification',
  'education.grade',
  'education.year',
  'documents.cv',
  'sensitive.disability',
  'sensitive.criminal_record',
  'sensitive.diversity',
  'declaration.truth',
  'consent.data_processing',
  'human.captcha',
  'human.mfa',
  'human.assessment',
  'unknown',
] as const;
export type FieldIntent = (typeof fieldIntents)[number];

/** Intents that may never be answered automatically, whatever the profile contains. */
export const humanOnlyIntents: readonly FieldIntent[] = [
  'sensitive.disability',
  'sensitive.criminal_record',
  'sensitive.diversity',
  'declaration.truth',
  'consent.data_processing',
  'human.captcha',
  'human.mfa',
  'human.assessment',
];

export const observedFieldSchema = z.object({
  fieldKey: z.string().min(1).max(120),
  label: z.string().max(400),
  controlType: z.enum(controlTypes),
  selector: z.string().min(1).max(400),
  required: z.boolean(),
  options: z.array(z.string().max(200)).max(60).default([]),
  maxLength: z.number().int().positive().max(100_000).optional(),
  group: z.string().max(80).optional(),
  groupIndex: z.number().int().min(0).max(50).optional(),
});
export type ObservedField = z.infer<typeof observedFieldSchema>;

export const fieldInventorySchema = z.object({
  stepId: z.string().min(1).max(80),
  url: z.string().min(1).max(2048),
  pageFingerprint: z.string().length(64),
  fields: z.array(observedFieldSchema).max(200),
  validationMessages: z.array(z.string().max(400)).max(50).default([]),
  humanOnlyMarkers: z.array(z.string().max(80)).max(20).default([]),
});
export type FieldInventory = z.infer<typeof fieldInventorySchema>;

export type MappedField = ObservedField & {
  intent: FieldIntent;
  confidence: number;
  sensitive: boolean;
  humanOnly: boolean;
};

type Rule = { intent: FieldIntent; confidence: number; match: RegExp };

// Deterministic, ordered rules. No model is involved: an advert or form cannot change the mapping
// by wording alone beyond matching one of these fixed patterns.
const rules: readonly Rule[] = [
  { intent: 'human.captcha', confidence: 1, match: /\b(captcha|i am not a robot|robot check)\b/i },
  {
    intent: 'human.mfa',
    confidence: 1,
    match: /\b(one[- ]time code|2fa|mfa|authenticat(or|ion) code|verification code)\b/i,
  },
  {
    intent: 'human.assessment',
    confidence: 1,
    match: /\b(assessment|aptitude test|situational judgement)\b/i,
  },
  {
    intent: 'declaration.truth',
    confidence: 1,
    match: /\b(declare|declaration|confirm that the information|true and complete)\b/i,
  },
  {
    intent: 'consent.data_processing',
    confidence: 1,
    match: /\b(consent|privacy notice|process my data|data protection statement)\b/i,
  },
  {
    intent: 'sensitive.disability',
    confidence: 1,
    match: /\b(disabilit\w*|long[- ]term health|reasonable adjustment)\b/i,
  },
  {
    intent: 'sensitive.criminal_record',
    confidence: 1,
    match: /\b(criminal|unspent conviction|disclosure|pvg|dbs)\b/i,
  },
  {
    intent: 'sensitive.diversity',
    confidence: 1,
    match:
      /\b(ethnic\w*|gender identity|sexual orientation|religion|equal opportunit\w*|diversity monitoring)\b/i,
  },
  {
    intent: 'documents.cv',
    confidence: 1,
    match: /\b(cv|curriculum vitae|r[eé]sum[eé]|upload your)\b/i,
  },
  {
    intent: 'identity.first_name',
    confidence: 0.98,
    match: /\b(first name|forename|given name)\b/i,
  },
  { intent: 'identity.last_name', confidence: 0.98, match: /\b(last name|surname|family name)\b/i },
  { intent: 'contact.email', confidence: 0.98, match: /\b(e[- ]?mail)\b/i },
  {
    intent: 'contact.phone',
    confidence: 0.98,
    match: /\b(phone|telephone|mobile|contact number)\b/i,
  },
  {
    intent: 'experience.years',
    confidence: 0.92,
    match: /\byears?\b.*\bexperience\b|\bexperience\b.*\byears?\b/i,
  },
  {
    intent: 'work_authorisation.visa_type',
    confidence: 0.95,
    match: /\b(visa type|type of visa|immigration route)\b/i,
  },
  {
    intent: 'work_authorisation.status',
    confidence: 0.95,
    match: /\b(right to work|work authorisation|eligible to work)\b/i,
  },
  {
    intent: 'preferences.contract_type',
    confidence: 0.9,
    match: /\b(contract type|contract preference|employment type)\b/i,
  },
  {
    intent: 'preferences.relocation',
    confidence: 0.85,
    match: /\b(relocat\w*|willing to move)\b/i,
  },
  {
    intent: 'statement.supporting',
    confidence: 0.9,
    match: /\b(supporting statement|personal statement|why are you applying|cover letter)\b/i,
  },
  {
    intent: 'employment.job_title',
    confidence: 0.9,
    match: /\b(job title|role title|position held)\b/i,
  },
  {
    intent: 'employment.employer',
    confidence: 0.9,
    match: /\b(employer|company name|organisation)\b/i,
  },
  {
    intent: 'employment.start_date',
    confidence: 0.85,
    match: /\b(start date|from date|date started)\b/i,
  },
  { intent: 'employment.end_date', confidence: 0.85, match: /\b(end date|to date|date left)\b/i },
  {
    intent: 'employment.duties',
    confidence: 0.85,
    match: /\b(duties|responsibilities|main tasks)\b/i,
  },
  {
    intent: 'education.institution',
    confidence: 0.9,
    match: /\b(school|college|university|institution)\b/i,
  },
  {
    intent: 'education.qualification',
    confidence: 0.9,
    match: /\b(qualification|degree|award|subject studied)\b/i,
  },
  { intent: 'education.grade', confidence: 0.85, match: /\b(grade|classification|result)\b/i },
  { intent: 'education.year', confidence: 0.8, match: /\b(year (awarded|obtained|completed))\b/i },
];

const MINIMUM_CONFIDENCE = 0.8;

export function mapField(field: ObservedField): MappedField {
  const haystack = `${field.label} ${field.fieldKey}`.replace(/_/g, ' ');
  for (const rule of rules) {
    if (!rule.match.test(haystack)) continue;
    // A rule is only accepted when the control type can carry that intent.
    if (rule.intent === 'documents.cv' && field.controlType !== 'file') continue;
    if (rule.intent !== 'documents.cv' && field.controlType === 'file') continue;
    return {
      ...field,
      intent: rule.intent,
      confidence: rule.confidence,
      sensitive: rule.intent.startsWith('sensitive.'),
      humanOnly: humanOnlyIntents.includes(rule.intent),
    };
  }
  return {
    ...field,
    intent: 'unknown',
    confidence: 0,
    sensitive: false,
    humanOnly: false,
  };
}

export function mapInventory(inventory: FieldInventory): MappedField[] {
  return inventory.fields.filter((field) => field.controlType !== 'button').map(mapField);
}

export function isConfidentlyMapped(field: MappedField): boolean {
  return field.intent !== 'unknown' && field.confidence >= MINIMUM_CONFIDENCE;
}
