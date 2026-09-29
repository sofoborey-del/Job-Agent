import type { KnowledgeFact } from '@job-agent/domain';
import { describe, expect, it } from 'vitest';

import { buildEmailApplicationDraft, type EmailApplicationDraft } from './draft.js';
import { detectEmailApplicationInstruction, type VerifiedEmailInstruction } from './instruction.js';
import {
  buildEmailReviewManifest,
  canonicalJson,
  chunkReview,
  renderEmailReview,
  type ManifestInput,
} from './manifest.js';

// Fixed fact ids, because the evidence behind a message is part of what is approved and therefore
// part of the hash. Random ids here would hide a genuine property rather than test one.
function fact(key: string, value: unknown): KnowledgeFact<unknown> {
  return {
    id: `fact-${key}`,
    key,
    value,
    status: 'verified',
    source: 'user',
    sensitivity: 'normal',
    usePolicy: 'auto_fill',
    allowedPurposes: ['matching', 'application'],
    version: 1,
  };
}

function instruction(description?: string): VerifiedEmailInstruction {
  const detected = detectEmailApplicationInstruction({
    canonicalUrl: 'https://www.exampleshire.gov.uk/jobs/12345',
    employer: 'Exampleshire Council',
    description:
      description ??
      'Email your application to recruitment@exampleshire.gov.uk.\nClosing date: 30 October 2026.',
    personSpecificationText: null,
    closesAt: '2026-10-30T23:59:00.000Z',
    jobVersion: 1,
    jobContentHash: 'a'.repeat(64),
  });
  if (detected.status !== 'verified') throw new Error('fixture advert should verify');
  return detected;
}

function draft(overrides: { statement?: string } = {}): EmailApplicationDraft {
  const facts = [
    fact('identity.legal_name', { given: 'Alex', family: 'Morgan' }),
    fact('contact.email', 'alex.morgan@example.test'),
    ...(overrides.statement === undefined
      ? []
      : [fact('statement.supporting', overrides.statement)]),
  ];
  const result = buildEmailApplicationDraft({
    instruction: instruction(),
    title: 'Community Support Worker',
    employer: 'Exampleshire Council',
    facts,
    approvedDocument: { documentId: 'doc-1', sha256: 'b'.repeat(64), filename: 'cv.pdf' },
  });
  if (result.status !== 'drafted') throw new Error('fixture should draft');
  return result.draft;
}

function manifestInput(overrides: Partial<ManifestInput> = {}): ManifestInput {
  return {
    userId: 'user-1',
    jobId: 'job-1',
    title: 'Community Support Worker',
    employer: 'Exampleshire Council',
    instruction: instruction(),
    draft: draft(),
    salaryGate: 'pass',
    salaryFloorMinor: 2_500_000,
    salaryOverride: false,
    transportProvider: 'gmail',
    policyVersion: 'email-v1',
    ...overrides,
  };
}

describe('the hash that binds an approval', () => {
  it('is stable for the same inputs', () => {
    expect(buildEmailReviewManifest(manifestInput()).manifestHash).toBe(
      buildEmailReviewManifest(manifestInput()).manifestHash,
    );
  });

  it('does not depend on the order object keys happen to be written in', () => {
    expect(canonicalJson({ b: 1, a: [2, { d: 4, c: 3 }] })).toBe(
      canonicalJson({ a: [2, { c: 3, d: 4 }], b: 1 }),
    );
  });

  it('never carries the message text itself, only its hash', () => {
    const { manifest } = buildEmailReviewManifest(
      manifestInput({ draft: draft({ statement: 'A sentence only the applicant wrote.' }) }),
    );
    expect(canonicalJson(manifest)).not.toContain('A sentence only the applicant wrote.');
    expect(manifest.bodySha256).toHaveLength(64);
  });

  const baseline = buildEmailReviewManifest(manifestInput()).manifestHash;

  it('changes when a word of the message changes', () => {
    const changed = buildEmailReviewManifest(
      manifestInput({ draft: draft({ statement: 'One extra sentence.' }) }),
    ).manifestHash;
    expect(changed).not.toBe(baseline);
  });

  it('changes when the attached CV changes', () => {
    const other = draft();
    const changed = buildEmailReviewManifest(
      manifestInput({
        draft: { ...other, attachment: { ...other.attachment, sha256: 'c'.repeat(64) } },
      }),
    ).manifestHash;
    expect(changed).not.toBe(baseline);
  });

  it('changes when the advert behind it changes', () => {
    const changed = buildEmailReviewManifest(
      manifestInput({ instruction: { ...instruction(), jobContentHash: 'f'.repeat(64) } }),
    ).manifestHash;
    expect(changed).not.toBe(baseline);
  });

  it('changes when the salary floor is overridden', () => {
    expect(buildEmailReviewManifest(manifestInput({ salaryOverride: true })).manifestHash).not.toBe(
      baseline,
    );
  });

  it('changes when a different provider would carry it', () => {
    expect(
      buildEmailReviewManifest(manifestInput({ transportProvider: 'fake' })).manifestHash,
    ).not.toBe(baseline);
  });
});

describe('the review a person reads', () => {
  it('shows the recipient, subject, attachment, advert instruction and whole message', () => {
    const { manifest } = buildEmailReviewManifest(manifestInput());
    const text = renderEmailReview({
      manifest,
      body: draft().body,
      approveCommand: '/apply approve id:abcd1234 manifest:0123456789ab',
    });

    expect(text).toContain('To: recruitment@exampleshire.gov.uk');
    expect(text).toContain('Subject: Application for Community Support Worker');
    expect(text).toContain('Attachment: cv.pdf');
    expect(text).toContain('> Email your application to recruitment@exampleshire.gov.uk.');
    expect(text).toContain('Yours faithfully,');
    expect(text).toContain('/apply approve id:abcd1234 manifest:0123456789ab');
    expect(text).toContain('nothing has been sent');
  });

  it('says plainly when the message makes no claim about experience', () => {
    const { manifest } = buildEmailReviewManifest(manifestInput());
    const text = renderEmailReview({ manifest, body: draft().body, approveCommand: '/apply' });
    expect(text).toContain('makes no claim about your experience');
  });

  it('flags an overridden salary floor in the review itself', () => {
    const { manifest } = buildEmailReviewManifest(
      manifestInput({ salaryGate: 'reject', salaryOverride: true }),
    );
    const text = renderEmailReview({ manifest, body: draft().body, approveCommand: '/apply' });
    expect(text).toContain('overriding the £25,000 minimum');
  });
});

describe('splitting a review for a chat service', () => {
  it('keeps every character, because a truncated review is not one you can approve', () => {
    const long = Array.from({ length: 120 }, (_, index) => `line ${String(index)} of the message`);
    const chunks = chunkReview(long.join('\n'), 400);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(400);
    const rejoined = chunks.map((chunk) => chunk.replace(/^\(\d+\/\d+\)\n/, '')).join('\n');
    for (const line of long) expect(rejoined).toContain(line);
  });

  it('numbers the parts, so a missing one is obvious', () => {
    const chunks = chunkReview('x'.repeat(2_000), 400);
    expect(chunks[0]).toMatch(/^\(1\/\d+\)/);
  });

  it('leaves a short review as one message with no part marker', () => {
    expect(chunkReview('short review')).toEqual(['short review']);
  });
});
