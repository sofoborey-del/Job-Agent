import type { KnowledgeFact } from '@job-agent/domain';
import { resolveFact } from '@job-agent/knowledge-base';

import type { AnswerSource, QuestionReason } from './actions.js';
import type { FieldIntent, MappedField } from './inventory.js';
import { isConfidentlyMapped } from './inventory.js';

export type ApplicationScopedAnswer = {
  fieldKey: string;
  value: string;
  answeredAt: string;
};

export type ResolvedAnswer = {
  status: 'resolved';
  value: string;
  source: AnswerSource;
  evidenceFactIds: string[];
};

export type UnresolvedAnswer = {
  status: 'requires_user';
  reason: QuestionReason;
  prompt: string;
};

export type AnswerResolution = ResolvedAnswer | UnresolvedAnswer;

/** Which verified fact key answers which mapped intent. Nothing is inferred beyond this table. */
const intentFactKeys: Partial<Record<FieldIntent, readonly string[]>> = {
  'identity.first_name': ['identity.first_name'],
  'identity.last_name': ['identity.last_name'],
  'contact.email': ['contact.email'],
  'contact.phone': ['contact.phone'],
  'experience.years': ['experience.years_total'],
  'preferences.contract_type': ['preferences.contract_type'],
  'work_authorisation.status': ['work_authorisation.gb'],
  'preferences.relocation': ['preferences.relocation'],
  'statement.supporting': ['statement.supporting'],
  'employment.employer': ['employment.current_employer'],
  'employment.job_title': ['employment.current_title'],
  'employment.start_date': ['employment.current_start_date'],
  'employment.end_date': ['employment.current_end_date'],
  'employment.duties': ['employment.current_duties'],
  'education.institution': ['education.institution'],
  'education.qualification': ['education.qualification'],
  'education.grade': ['education.grade'],
  'education.year': ['education.year'],
};

function stringify(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() === '' ? null : value;
  if (typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (Array.isArray(value)) {
    const parts = value.filter((item): item is string => typeof item === 'string');
    return parts.length === 0 ? null : parts.join(', ');
  }
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    if (typeof record.authorised === 'boolean') return record.authorised ? 'Yes' : 'No';
    if (typeof record.value === 'string') return record.value;
  }
  return null;
}

export type ResolveOptions = {
  field: MappedField;
  facts: readonly KnowledgeFact<unknown>[];
  applicationAnswers: readonly ApplicationScopedAnswer[];
  now?: Date;
};

/**
 * Produces an answer only from a verified fact whose use policy allows application use, or from an
 * answer the user gave for this application. Every other outcome pauses the workflow. The resolver
 * never composes, guesses or paraphrases an applicant claim.
 */
export function resolveAnswer(options: ResolveOptions): AnswerResolution {
  const { field } = options;
  const now = options.now ?? new Date();

  const scoped = options.applicationAnswers.find((answer) => answer.fieldKey === field.fieldKey);
  if (scoped !== undefined) {
    return {
      status: 'resolved',
      value: scoped.value,
      source: 'application_scoped_answer',
      evidenceFactIds: [],
    };
  }

  if (field.humanOnly || field.sensitive) {
    return {
      status: 'requires_user',
      reason: field.sensitive ? 'sensitive_question' : 'human_only_step',
      prompt: `"${field.label}" must be answered by you. The agent will not answer it.`,
    };
  }

  if (!isConfidentlyMapped(field)) {
    return {
      status: 'requires_user',
      reason: 'unknown_field',
      prompt: `The form asks "${field.label}" and the agent does not recognise it. How should it be answered?`,
    };
  }

  const candidateKeys = intentFactKeys[field.intent] ?? [];
  if (candidateKeys.length === 0) {
    return {
      status: 'requires_user',
      reason: 'ambiguous_mapping',
      prompt: `"${field.label}" has no profile fact behind it. How should it be answered?`,
    };
  }

  for (const key of candidateKeys) {
    const fact = options.facts.find((candidate) => candidate.key === key);
    if (fact === undefined) continue;
    const resolution = resolveFact(fact, 'application', now);
    if (resolution.status === 'resolved') {
      const value = stringify(resolution.value);
      if (value === null) break;
      return {
        status: 'resolved',
        value,
        source: 'verified_fact',
        evidenceFactIds: [fact.id],
      };
    }
    const reason: QuestionReason =
      resolution.reason === 'fact_expired'
        ? 'expired_fact'
        : resolution.reason === 'high_risk_value'
          ? 'sensitive_question'
          : resolution.reason === 'ask_each_time' || resolution.reason === 'never_auto_fill'
            ? 'use_policy_forbids'
            : 'unverified_fact';
    return {
      status: 'requires_user',
      reason,
      prompt: `"${field.label}" needs your confirmation before it can be used.`,
    };
  }

  return {
    status: 'requires_user',
    reason: 'missing_evidence',
    prompt: `Your profile has nothing verified that answers "${field.label}". What should it say?`,
  };
}
