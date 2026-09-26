import type { KnowledgeFact } from '@job-agent/domain';
import { resolveFact } from '@job-agent/knowledge-base';
import { z } from 'zod';

import type { QuestionReason } from './actions.js';
import type { AnswerResolution } from './resolver.js';
import type { FieldIntent } from './inventory.js';
import { realSiteHumanOnlyIntents } from './real-site.js';

/**
 * Grounded answers for a real employer form.
 *
 * The fake-ATS resolver maps intents onto the flat synthetic fact keys that walkthrough uses. A
 * real profile stores structured history instead, so this resolver reads those structures and
 * refuses anything it cannot ground in one.
 *
 * Every path here either returns a value taken verbatim from a verified fact, or asks the user.
 * Nothing is derived, summarised, reworded or inferred: an employment date, a qualification or a
 * reason for leaving that is not present in the profile becomes a question, never a guess.
 */

const legalNameSchema = z.object({
  given: z.string().min(1),
  family: z.string().min(1),
  preferred: z.string().optional(),
});

const employmentRowSchema = z.object({
  employer: z.string().min(1),
  title: z.string().min(1),
  startDate: z.string().min(1).nullish(),
  endDate: z.string().min(1).nullish(),
  evidenceSummary: z.string().min(1).nullish(),
});

const educationRowSchema = z.object({
  institution: z.string().min(1),
  qualification: z.string().min(1),
  field: z.string().min(1).nullish(),
  grade: z.string().min(1).nullish(),
  startDate: z.string().min(1).nullish(),
  endDate: z.string().min(1).nullish(),
});

const leavingReasonSchema = z.object({
  employer: z.string().min(1),
  reasonForLeaving: z.string().min(1),
  contractType: z.string().optional(),
});

const workAuthorisationSchema = z.object({
  authorised: z.boolean(),
  restrictions: z.array(z.string()).nullish(),
  sponsorshipRequiredNow: z.boolean().nullish(),
  sponsorshipRequiredFuture: z.boolean().nullish(),
});

export type RealSiteApprovedDocument = {
  documentId: string;
  sha256: string;
  filename: string;
};

export type RealSiteResolutionInput = {
  intent: FieldIntent;
  /** Which row of a repeated employment or education section this field belongs to. */
  rowIndex?: number;
  facts: readonly KnowledgeFact<unknown>[];
  approvedDocument?: RealSiteApprovedDocument | null;
  now?: Date;
};

function ask(reason: QuestionReason, prompt: string): AnswerResolution {
  return { status: 'requires_user', reason, prompt };
}

function normalise(value: string): string {
  return value
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Resolves one fact for application use, applying every knowledge-base gate. */
function usable(
  facts: readonly KnowledgeFact<unknown>[],
  key: string,
  now: Date,
): { value: unknown; factId: string } | null {
  const fact = facts.find((candidate) => candidate.key === key);
  if (fact === undefined) return null;
  const resolution = resolveFact(fact, 'application', now);
  return resolution.status === 'resolved'
    ? { value: resolution.value, factId: resolution.factId }
    : null;
}

function resolved(value: string, factIds: string[]): AnswerResolution {
  return { status: 'resolved', value, source: 'verified_fact', evidenceFactIds: factIds };
}

export function resolveRealSiteAnswer(input: RealSiteResolutionInput): AnswerResolution {
  const now = input.now ?? new Date();
  const { facts, intent } = input;
  const row = input.rowIndex ?? 0;

  if (realSiteHumanOnlyIntents.has(intent) || intent === 'consent.data_processing') {
    return ask('sensitive_question', 'This question is yours to answer.');
  }

  if (intent === 'identity.first_name' || intent === 'identity.last_name') {
    const found = usable(facts, 'identity.legal_name', now);
    if (found === null) return ask('missing_evidence', 'What name should the application show?');
    const parsed = legalNameSchema.safeParse(found.value);
    if (!parsed.success) return ask('missing_evidence', 'What name should the application show?');
    const value = intent === 'identity.first_name' ? parsed.data.given : parsed.data.family;
    return resolved(value, [found.factId]);
  }

  if (intent === 'contact.email' || intent === 'contact.phone') {
    const key = intent === 'contact.email' ? 'contact.email' : 'contact.phone';
    const found = usable(facts, key, now);
    if (found === null || typeof found.value !== 'string') {
      return ask(
        'missing_evidence',
        `What ${intent === 'contact.email' ? 'email address' : 'phone number'} should this application use?`,
      );
    }
    return resolved(found.value, [found.factId]);
  }

  if (intent.startsWith('employment.')) {
    const found = usable(facts, 'employment.history', now);
    const parsed = z.array(employmentRowSchema).safeParse(found?.value);
    if (found === null || !parsed.success) {
      return ask('missing_evidence', 'Your employment history is not recorded in a usable form.');
    }
    const entry = parsed.data[row];
    if (entry === undefined) {
      return ask(
        'missing_evidence',
        `Your profile holds ${String(parsed.data.length)} recorded role(s) and this form asks for another. Enter it yourself, or add it to your profile first.`,
      );
    }

    if (intent === 'employment.leaving_reason') {
      // Joined on the employer name recorded inside the reason itself, not on a key guessed from
      // the row. A reason is never attached to an employer it does not name.
      const target = normalise(entry.employer);
      for (const fact of facts) {
        if (!fact.key.startsWith('employment.leaving_reasons.')) continue;
        const reason = usable(facts, fact.key, now);
        if (reason === null) continue;
        const shape = leavingReasonSchema.safeParse(reason.value);
        if (!shape.success) continue;
        if (normalise(shape.data.employer) === target) {
          return resolved(shape.data.reasonForLeaving, [reason.factId, found.factId]);
        }
      }
      return ask(
        'missing_evidence',
        'No recorded reason for leaving matches that employer. What should it say?',
      );
    }

    const value =
      intent === 'employment.employer'
        ? entry.employer
        : intent === 'employment.job_title'
          ? entry.title
          : intent === 'employment.start_date'
            ? entry.startDate
            : intent === 'employment.end_date'
              ? entry.endDate
              : intent === 'employment.duties'
                ? entry.evidenceSummary
                : null;
    if (value === null || value === undefined || value === '') {
      return ask(
        'missing_evidence',
        'That detail is not recorded for this role. What should it say?',
      );
    }
    return resolved(value, [found.factId]);
  }

  if (intent.startsWith('education.')) {
    const found = usable(facts, 'education.history', now);
    const parsed = z.array(educationRowSchema).safeParse(found?.value);
    if (found === null || !parsed.success) {
      return ask('missing_evidence', 'Your education history is not recorded in a usable form.');
    }
    const entry = parsed.data[row];
    if (entry === undefined) {
      return ask(
        'missing_evidence',
        `Your profile holds ${String(parsed.data.length)} recorded qualification(s) and this form asks for another.`,
      );
    }
    const value =
      intent === 'education.institution'
        ? entry.institution
        : intent === 'education.qualification'
          ? entry.qualification
          : intent === 'education.grade'
            ? entry.grade
            : intent === 'education.year'
              ? entry.endDate
              : null;
    if (value === null || value === undefined || value === '') {
      return ask('missing_evidence', 'That detail is not recorded for this qualification.');
    }
    return resolved(value, [found.factId]);
  }

  if (intent === 'work_authorisation.status') {
    const found = usable(facts, 'work_authorisation.gb', now);
    const parsed = workAuthorisationSchema.safeParse(found?.value);
    if (found === null || !parsed.success) {
      return ask('missing_evidence', 'How should the right-to-work question be answered?');
    }
    // Anything conditional is the user's to explain in their own words.
    const conditional =
      (parsed.data.restrictions?.length ?? 0) > 0 ||
      parsed.data.sponsorshipRequiredNow === true ||
      parsed.data.sponsorshipRequiredFuture === true;
    if (conditional || !parsed.data.authorised) {
      return ask(
        'sensitive_question',
        'Your right to work has conditions recorded against it. Answer this one yourself.',
      );
    }
    return resolved('Yes', [found.factId]);
  }

  if (intent === 'documents.cv') {
    const document = input.approvedDocument;
    if (document === null || document === undefined) {
      return ask('missing_evidence', 'No approved CV is available to upload.');
    }
    return {
      status: 'resolved',
      value: document.filename,
      source: 'approved_document',
      evidenceFactIds: [],
    };
  }

  if (intent === 'statement.supporting') {
    const found = usable(facts, 'statement.supporting', now);
    if (found === null || typeof found.value !== 'string') {
      // Deliberate: a supporting statement is argued, not stored. The agent will not compose one.
      return ask(
        'missing_evidence',
        'Write your supporting statement yourself. The agent will not draft claims about your experience.',
      );
    }
    return resolved(found.value, [found.factId]);
  }

  return ask('unknown_field', 'The agent did not recognise that question.');
}
