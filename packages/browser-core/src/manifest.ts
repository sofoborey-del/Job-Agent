import { createHash } from 'node:crypto';

import type { FieldIntent } from './inventory.js';

export type ManifestAnswer = {
  stepId: string;
  fieldKey: string;
  label: string;
  intent: FieldIntent;
  /** A hash, never the value. The value itself stays encrypted in the database. */
  answerHash: string | null;
  answerPreview: string | null;
  source: string;
  evidenceFactIds: string[];
  sensitive: boolean;
  required: boolean;
};

export type ReviewManifest = {
  applicationId: string;
  attemptId: string;
  jobId: string;
  jobVersion: number;
  adapterId: string;
  adapterVersion: string;
  cvDocumentId: string | null;
  cvSha256: string | null;
  formFingerprints: Array<{ stepId: string; pageFingerprint: string }>;
  answers: ManifestAnswer[];
  outstandingQuestions: number;
  createdAt: string;
};

export function hashAnswerValue(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** Short, non-reversible preview for the review screen: length and shape only. */
export function previewFor(value: string, sensitive: boolean): string | null {
  if (sensitive) return null;
  if (value.length <= 48) return value;
  return `${value.slice(0, 45)}…`;
}

/**
 * The snapshot hash binds an approval to the exact job version, adapter version, CV hash, form
 * fingerprints and answers. Changing any of them produces a different hash, which invalidates the
 * approval and the submit intent derived from it.
 */
export function manifestHash(manifest: ReviewManifest): string {
  const material = JSON.stringify({
    applicationId: manifest.applicationId,
    attemptId: manifest.attemptId,
    jobId: manifest.jobId,
    jobVersion: manifest.jobVersion,
    adapterId: manifest.adapterId,
    adapterVersion: manifest.adapterVersion,
    cvDocumentId: manifest.cvDocumentId,
    cvSha256: manifest.cvSha256,
    formFingerprints: [...manifest.formFingerprints].sort((left, right) =>
      left.stepId.localeCompare(right.stepId),
    ),
    answers: [...manifest.answers]
      .map((answer) => ({
        stepId: answer.stepId,
        fieldKey: answer.fieldKey,
        intent: answer.intent,
        answerHash: answer.answerHash,
        source: answer.source,
        evidenceFactIds: [...answer.evidenceFactIds].sort((a, b) => a.localeCompare(b)),
      }))
      .sort((left, right) =>
        `${left.stepId}:${left.fieldKey}`.localeCompare(`${right.stepId}:${right.fieldKey}`),
      ),
    outstandingQuestions: manifest.outstandingQuestions,
  });
  return createHash('sha256').update(material).digest('hex');
}

export type ManifestComparison = {
  same: boolean;
  changed: string[];
};

export function compareManifests(
  previous: ReviewManifest,
  next: ReviewManifest,
): ManifestComparison {
  const changed: string[] = [];
  if (previous.jobVersion !== next.jobVersion) changed.push('job_version');
  if (previous.adapterVersion !== next.adapterVersion) changed.push('adapter_version');
  if (previous.cvSha256 !== next.cvSha256) changed.push('cv_document');
  const previousPrints = new Map(
    previous.formFingerprints.map((f) => [f.stepId, f.pageFingerprint]),
  );
  for (const print of next.formFingerprints) {
    if (previousPrints.get(print.stepId) !== print.pageFingerprint)
      changed.push(`form:${print.stepId}`);
  }
  const previousAnswers = new Map(
    previous.answers.map((answer) => [`${answer.stepId}:${answer.fieldKey}`, answer.answerHash]),
  );
  for (const answer of next.answers) {
    const key = `${answer.stepId}:${answer.fieldKey}`;
    if (!previousAnswers.has(key)) changed.push(`added:${key}`);
    else if (previousAnswers.get(key) !== answer.answerHash) changed.push(`answer:${key}`);
  }
  for (const key of previousAnswers.keys()) {
    if (!next.answers.some((answer) => `${answer.stepId}:${answer.fieldKey}` === key)) {
      changed.push(`removed:${key}`);
    }
  }
  return { same: changed.length === 0, changed: [...new Set(changed)] };
}
