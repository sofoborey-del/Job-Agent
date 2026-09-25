import { createHash } from 'node:crypto';

import { redact, REDACTED } from '@job-agent/observability';

export type RedactionSubject = {
  /** Applicant values that must never appear in an artefact, log or error. */
  secrets: readonly string[];
};

const MINIMUM_SECRET_LENGTH = 3;

/**
 * Replaces every applicant value with a placeholder, then removes anything else that looks like a
 * token. Used on validation messages, page text, error payloads and artefact metadata before they
 * leave the worker boundary.
 */
export function redactText(text: string, subject: RedactionSubject): string {
  let output = text;
  const ordered = [...subject.secrets]
    .filter((secret) => secret.trim().length >= MINIMUM_SECRET_LENGTH)
    .sort((left, right) => right.length - left.length);
  for (const secret of ordered) {
    output = output.split(secret).join(REDACTED);
  }
  return String(redact(output));
}

export function redactStrings(values: readonly string[], subject: RedactionSubject): string[] {
  return values.map((value) => redactText(value, subject));
}

export type ScreenshotRedactionPlan = {
  /** CSS selectors the worker masks before the pixels are captured. */
  maskSelectors: string[];
  fullPage: boolean;
};

export function screenshotPlanFor(selectors: readonly string[]): ScreenshotRedactionPlan {
  return {
    maskSelectors: [
      'input:not([type=submit]):not([type=button])',
      'textarea',
      'select',
      '[data-applicant-value]',
      ...selectors,
    ],
    fullPage: false,
  };
}

export type ArtifactMetadata = {
  kind: 'screenshot' | 'trace' | 'validation_log' | 'page_fingerprint';
  objectKey: string;
  sha256: string;
  bytes: number;
  redacted: true;
};

export function artifactMetadata(input: {
  kind: ArtifactMetadata['kind'];
  objectKey: string;
  bytes: number;
  content: Buffer | string;
}): ArtifactMetadata {
  return {
    kind: input.kind,
    objectKey: input.objectKey,
    sha256: createHash('sha256').update(input.content).digest('hex'),
    bytes: input.bytes,
    redacted: true,
  };
}

/**
 * The only shape allowed to cross out of the worker process. Page text, cookies, storage state and
 * raw applicant values are deliberately absent.
 */
export type WorkerReport = {
  attemptId: string;
  stepId: string;
  url: string;
  pageFingerprint: string;
  inventory: unknown;
  validationMessages: string[];
  artifacts: ArtifactMetadata[];
  outcome: string;
  confirmationReference: string | null;
  errorCode: string | null;
};

const forbiddenReportKeys = new Set([
  'cookies',
  'storageState',
  'localStorage',
  'sessionStorage',
  'html',
  'content',
  'pageText',
  'value',
  'values',
  'answers',
  'headers',
]);

/** Defence in depth: strips anything that should never have been put on a worker report. */
export function sanitiseWorkerReport(report: Record<string, unknown>): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(report)) {
    if (forbiddenReportKeys.has(key)) continue;
    output[key] = value;
  }
  return output;
}
