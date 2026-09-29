import { createHash } from 'node:crypto';

import { resolveRealSiteAnswer, type RealSiteApprovedDocument } from '@job-agent/browser-core';
import type { KnowledgeFact } from '@job-agent/domain';

import type { VerifiedEmailInstruction } from './instruction.js';

/**
 * The message that would be sent, built only from things that are already true.
 *
 * Every variable part of the body is one of:
 *
 * - a value taken verbatim from one verified profile fact, resolved through `resolveRealSiteAnswer`
 *   so that every knowledge-base gate — verified, unexpired, allowed for application use — applies
 *   exactly as it would to a real prefill;
 * - the vacancy's title, employer, address and reference, which are normalised discovery fields;
 * - fixed wording that makes no claim about the applicant.
 *
 * There is no sentence anywhere in this file that asserts experience, suitability, qualifications or
 * enthusiasm. The agent does not argue the applicant's case: if the profile holds a supporting
 * statement the applicant wrote, it is included word for word, and if it does not, the message says
 * nothing in its place. It also never agrees to a declaration: an advert that asks for one is
 * answered by the person, on the employer's own form.
 */

export const draftRefusals = [
  'missing_name',
  'missing_contact_email',
  'no_approved_cv',
  'unsafe_job_text',
] as const;
export type DraftRefusal = (typeof draftRefusals)[number];

export type EmailApplicationDraft = {
  recipient: string;
  subject: string;
  body: string;
  bodySha256: string;
  bodyCharacters: number;
  /** Where a reply should go: the applicant's own recorded address, not the sending mailbox. */
  replyTo: string;
  attachment: RealSiteApprovedDocument;
  evidenceFactIds: readonly string[];
  includedSupportingStatement: boolean;
  /** Things the person should know before approving. Never a reason to refuse on its own. */
  warnings: readonly string[];
};

export type DraftResult =
  | { status: 'drafted'; draft: EmailApplicationDraft }
  | { status: 'refused'; reason: DraftRefusal; detail: string };

export type DraftInput = {
  instruction: VerifiedEmailInstruction;
  title: string;
  employer: string;
  facts: readonly KnowledgeFact<unknown>[];
  approvedDocument: RealSiteApprovedDocument | null;
  now?: Date;
};

/**
 * First-person claim wording. An advert title or employer name is untrusted text that ends up
 * inside a message signed by the applicant, so anything shaped like a statement the applicant would
 * be making stops the draft rather than being copied into it.
 */
const claimPatterns: readonly RegExp[] = [
  /\bI\s+(?:confirm|declare|certify|agree|consent|hold|have|am|possess|accept)\b/i,
  /\bmy\s+(?:application|experience|qualification|licence|license|cv)\b/i,
  /\b(?:please\s+)?(?:ignore|disregard|override)\b/i,
  /\bticked?\b/i,
  /\bdeclaration\b/i,
];

// Control characters are exactly what this looks for: an advert field carrying one is not text
// that belongs in a message the applicant signs.
// eslint-disable-next-line no-control-regex
const controlCharacters = /[\u0000-\u001f\u007f-\u009f]/;

function safeVacancyText(value: string): string | null {
  if (controlCharacters.test(value)) return null;
  if (claimPatterns.some((pattern) => pattern.test(value))) return null;
  const tidy = value.replace(/\s+/g, ' ').trim();
  if (tidy === '' || tidy.length > 200) return null;
  return tidy;
}

function resolve(
  intent: Parameters<typeof resolveRealSiteAnswer>[0]['intent'],
  facts: readonly KnowledgeFact<unknown>[],
  now: Date,
): { value: string; factIds: readonly string[] } | null {
  const resolution = resolveRealSiteAnswer({ intent, facts, now });
  return resolution.status === 'resolved'
    ? { value: resolution.value, factIds: resolution.evidenceFactIds }
    : null;
}

function refuse(reason: DraftRefusal, detail: string): DraftResult {
  return { status: 'refused', reason, detail };
}

export function buildEmailApplicationDraft(input: DraftInput): DraftResult {
  const now = input.now ?? new Date();
  const { instruction, facts } = input;

  const title = safeVacancyText(input.title);
  const employer = safeVacancyText(input.employer);
  if (title === null || employer === null) {
    return refuse(
      'unsafe_job_text',
      'The advert’s job title or employer name contains wording that would read as a statement by you. It will not be copied into a message you sign.',
    );
  }

  const document = input.approvedDocument;
  if (document === null) {
    return refuse(
      'no_approved_cv',
      'There is no approved CV to attach. Approve one on the CV review screen first.',
    );
  }

  const given = resolve('identity.first_name', facts, now);
  const family = resolve('identity.last_name', facts, now);
  if (given === null || family === null) {
    return refuse(
      'missing_name',
      'Your name is not recorded as a verified fact usable for applications, so nothing can be signed.',
    );
  }

  const email = resolve('contact.email', facts, now);
  if (email === null) {
    return refuse(
      'missing_contact_email',
      'No verified contact email address is recorded, so the employer would have no way to reply to you.',
    );
  }

  const phone = resolve('contact.phone', facts, now);
  const statement = resolve('statement.supporting', facts, now);

  // The only composition anywhere in this message: the two recorded halves of a name, joined by a
  // space to sign it. Neither half is altered, and nothing else is assembled from parts.
  const signature = `${given.value} ${family.value}`;

  const reference = instruction.vacancyReference?.value ?? null;
  const subject =
    reference === null
      ? `Application for ${title} — ${employer}`
      : `Application for ${title} (reference ${reference}) — ${employer}`;

  const lines: string[] = [
    'Dear Sir or Madam,',
    '',
    reference === null
      ? `I would like to apply for the post of ${title} with ${employer}, advertised at ${instruction.sourceUrl}.`
      : `I would like to apply for the post of ${title} with ${employer}, reference ${reference}, advertised at ${instruction.sourceUrl}.`,
    '',
    `My CV is attached as ${document.filename}.`,
  ];

  if (statement !== null) {
    lines.push('', statement.value);
  }

  lines.push('', 'Yours faithfully,', signature, email.value);
  if (phone !== null) lines.push(phone.value);

  const body = `${lines.join('\n')}\n`;

  const warnings: string[] = [];
  if (statement === null) {
    warnings.push(
      'Your profile holds no supporting statement, so this message says nothing about why you suit the post. The agent will not write one for you.',
    );
  }
  if (phone === null) {
    warnings.push('No verified phone number is recorded, so none is given.');
  }
  if (instruction.recipientCorroboration === 'none') {
    warnings.push(
      `The address ${instruction.recipient} is not on the domain the advert was published on, and does not match the employer’s name. Check it against the advert before approving.`,
    );
  }

  return {
    status: 'drafted',
    draft: {
      recipient: instruction.recipient,
      subject,
      body,
      bodySha256: createHash('sha256').update(body, 'utf8').digest('hex'),
      bodyCharacters: body.length,
      replyTo: email.value,
      attachment: document,
      evidenceFactIds: [
        ...new Set([
          ...given.factIds,
          ...family.factIds,
          ...email.factIds,
          ...(phone?.factIds ?? []),
          ...(statement?.factIds ?? []),
        ]),
      ],
      includedSupportingStatement: statement !== null,
      warnings,
    },
  };
}
