import { createHash } from 'node:crypto';

import type { EmailApplicationDraft } from './draft.js';
import type { VerifiedEmailInstruction } from './instruction.js';

/**
 * What the person approves, and the hash that binds their approval to it.
 *
 * The manifest holds every input that could change what an employer receives. If any of them
 * changes — a word of the body, the recipient, the attached CV, the advert version behind it — the
 * hash changes, the earlier approval no longer matches, and the send is refused as stale. That is
 * the whole mechanism; there is no separate staleness check to forget to run.
 *
 * The body is represented by its SHA-256 rather than its text. The manifest is a durable record
 * that lands in the database and in audit metadata, and the body is applicant data, so it is stored
 * once, encrypted, and referenced everywhere else by hash.
 */

export const EMAIL_MANIFEST_VERSION = 'email-application-1.0.0';

export type EmailReviewManifest = {
  manifestVersion: string;
  policyVersion: string;
  userId: string;
  jobId: string;
  jobVersion: number;
  jobContentHash: string;
  title: string;
  employer: string;
  advertUrl: string;
  closesAt: string | null;
  recipient: string;
  recipientDomain: string;
  recipientCorroboration: VerifiedEmailInstruction['recipientCorroboration'];
  instructionText: string;
  instructionSource: VerifiedEmailInstruction['instructionSource'];
  vacancyReference: string | null;
  subject: string;
  bodySha256: string;
  bodyCharacters: number;
  replyTo: string;
  attachment: { documentId: string; filename: string; sha256: string };
  evidenceFactIds: readonly string[];
  includedSupportingStatement: boolean;
  salaryGate: 'pass' | 'reject' | 'unknown';
  salaryFloorMinor: number;
  salaryOverride: boolean;
  /** Which provider would carry the message. An approval is not transferable between providers. */
  transportProvider: string;
  /**
   * What the person was warned about alongside the message. Part of the manifest, and therefore of
   * the hash, because a review that carried a different warning was a different review.
   */
  warnings: readonly string[];
};

/** Stable JSON: object keys sorted, so the same manifest always hashes the same way. */
export function canonicalJson(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
}

export function hashManifest(manifest: EmailReviewManifest): string {
  return createHash('sha256').update(canonicalJson(manifest), 'utf8').digest('hex');
}

export type ManifestInput = {
  userId: string;
  jobId: string;
  title: string;
  employer: string;
  instruction: VerifiedEmailInstruction;
  draft: EmailApplicationDraft;
  salaryGate: 'pass' | 'reject' | 'unknown';
  salaryFloorMinor: number;
  salaryOverride: boolean;
  transportProvider: string;
  policyVersion: string;
};

export function buildEmailReviewManifest(input: ManifestInput): {
  manifest: EmailReviewManifest;
  manifestHash: string;
} {
  const { instruction, draft } = input;
  const manifest: EmailReviewManifest = {
    manifestVersion: EMAIL_MANIFEST_VERSION,
    policyVersion: input.policyVersion,
    userId: input.userId,
    jobId: input.jobId,
    jobVersion: instruction.jobVersion,
    jobContentHash: instruction.jobContentHash,
    title: input.title,
    employer: input.employer,
    advertUrl: instruction.sourceUrl,
    closesAt: instruction.closingDate.iso,
    recipient: draft.recipient,
    recipientDomain: instruction.recipientDomain,
    recipientCorroboration: instruction.recipientCorroboration,
    instructionText: instruction.instructionText,
    instructionSource: instruction.instructionSource,
    vacancyReference: instruction.vacancyReference?.value ?? null,
    subject: draft.subject,
    bodySha256: draft.bodySha256,
    bodyCharacters: draft.bodyCharacters,
    replyTo: draft.replyTo,
    attachment: {
      documentId: draft.attachment.documentId,
      filename: draft.attachment.filename,
      sha256: draft.attachment.sha256,
    },
    evidenceFactIds: [...draft.evidenceFactIds].sort(),
    includedSupportingStatement: draft.includedSupportingStatement,
    salaryGate: input.salaryGate,
    salaryFloorMinor: input.salaryFloorMinor,
    salaryOverride: input.salaryOverride,
    transportProvider: input.transportProvider,
    warnings: [...draft.warnings],
  };
  return { manifest, manifestHash: hashManifest(manifest) };
}

function money(minor: number): string {
  return `£${Math.round(minor / 100).toLocaleString('en-GB')}`;
}

/**
 * The review text a person reads before approving.
 *
 * It shows the message exactly as it would be sent, because approving text you cannot see is not
 * approval. This is the one place applicant wording is put in front of the chat service, and it
 * exists only because the approval decision is worthless without it. Every other notification, every
 * outbox row and every log line about this application carries identifiers and counts only.
 */
export function renderEmailReview(input: {
  manifest: EmailReviewManifest;
  body: string;
  /** The command the person types back, carrying the review reference they were shown. */
  approveCommand: string;
}): string {
  const { manifest } = input;
  const lines: string[] = [
    '**Ready to send — nothing has been sent yet**',
    `Vacancy: ${manifest.title} — ${manifest.employer}`,
    `Advert: ${manifest.advertUrl}`,
    manifest.closesAt === null
      ? 'Closing date: not recorded'
      : `Closing date: ${manifest.closesAt.slice(0, 10)}`,
    '',
    `To: ${manifest.recipient}`,
    `Reply-To: ${manifest.replyTo}`,
    `Subject: ${manifest.subject}`,
    `Attachment: ${manifest.attachment.filename} (SHA-256 ${manifest.attachment.sha256.slice(0, 12)}…)`,
    '',
    'The advert’s own instruction, word for word:',
    `> ${manifest.instructionText}`,
    manifest.recipientCorroboration === 'advert_domain'
      ? '✅ That address is on the same domain as the advert.'
      : manifest.recipientCorroboration === 'employer_name'
        ? '⚠️ That address is not on the advert’s domain, but its domain matches the employer’s name.'
        : '⚠️ That address is neither on the advert’s domain nor matched to the employer’s name. Check it yourself.',
    '',
    manifest.salaryOverride
      ? `⚠️ You are overriding the ${money(manifest.salaryFloorMinor)} minimum for this vacancy (salary check: ${manifest.salaryGate}).`
      : `Salary check: ${manifest.salaryGate} against a ${money(manifest.salaryFloorMinor)} minimum.`,
    manifest.includedSupportingStatement
      ? 'The message includes your recorded supporting statement, word for word.'
      : 'The message makes no claim about your experience. Only your CV speaks for you.',
    ...manifest.warnings.map((warning) => `⚠️ ${warning}`),
    '',
    '--- message body, exactly as it will be sent ---',
    input.body.trimEnd(),
    '--- end of message body ---',
    '',
    `Approve with: ${input.approveCommand}`,
    'Rejecting sends nothing. Approval can be used once, and only for this exact message.',
  ];
  return lines.join('\n');
}

/**
 * Splits a review into messages a chat service will accept whole.
 *
 * Truncating would be worse than useless here: the person would approve a message whose ending they
 * never saw. Each part is numbered so a missing part is obvious.
 */
export function chunkReview(text: string, limit = 1_800): string[] {
  if (limit < 200) throw new RangeError('A review chunk limit below 200 characters is unusable');
  const body = text.split('\n');
  const parts: string[] = [];
  let current = '';
  for (const line of body) {
    // A single line longer than the limit is split on width; nothing is dropped.
    let remaining = line;
    do {
      const piece = remaining.slice(0, limit - 40);
      remaining = remaining.slice(piece.length);
      if (current.length + piece.length + 1 > limit - 40) {
        if (current !== '') parts.push(current);
        current = piece;
      } else {
        current = current === '' ? piece : `${current}\n${piece}`;
      }
    } while (remaining !== '');
  }
  if (current !== '') parts.push(current);
  if (parts.length <= 1) return parts.length === 0 ? [''] : parts;
  return parts.map((part, index) => `(${String(index + 1)}/${String(parts.length)})\n${part}`);
}
