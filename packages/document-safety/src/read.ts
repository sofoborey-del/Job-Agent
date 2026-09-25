import { createHash } from 'node:crypto';

import { extractDocxText, extractPdfText, normaliseExtractedText } from './extract.js';
import { hasExpectedSignature, inspectDocx, inspectPdf } from './inspect.js';
import {
  DOCX_MIME,
  PDF_MIME,
  ThreatDetectedError,
  type MalwareScanner,
  type SafeDocumentMimeType,
} from './scanner.js';

/** Why a document could not be turned into trustworthy text. Every value fails closed. */
export type DocumentRejectionReason =
  | 'unsupported_type'
  | 'signature_mismatch'
  | 'active_content'
  | 'malware_detected'
  | 'scan_unavailable'
  | 'unreadable'
  | 'too_little_text';

export type SafeDocumentRead =
  | {
      status: 'read';
      text: string;
      sha256: string;
      byteLength: number;
      mimeType: SafeDocumentMimeType;
      warnings: string[];
    }
  | { status: 'rejected'; reason: DocumentRejectionReason; detail: string };

function isSupported(mimeType: string): mimeType is SafeDocumentMimeType {
  return mimeType === PDF_MIME || mimeType === DOCX_MIME;
}

/**
 * Inspect, scan and extract, in that order, and never return text that skipped a step.
 *
 * The byte buffer is zeroed before returning so an untrusted document does not linger in memory.
 * The returned text is data. It is never treated as instructions, and callers must not pass it to
 * a model as anything other than quoted content.
 */
export async function readDocumentSafely(input: {
  bytes: Buffer;
  mimeType: string;
  scanner: MalwareScanner;
  minimumCharacters?: number;
  maxPages?: number;
}): Promise<SafeDocumentRead> {
  const { bytes, mimeType, scanner } = input;
  const minimumCharacters = input.minimumCharacters ?? 40;
  if (!isSupported(mimeType)) {
    return {
      status: 'rejected',
      reason: 'unsupported_type',
      detail: `Unsupported document type: ${mimeType}`,
    };
  }

  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const byteLength = bytes.byteLength;

  if (!hasExpectedSignature(bytes, mimeType)) {
    return {
      status: 'rejected',
      reason: 'signature_mismatch',
      detail: 'The bytes do not begin as the declared content type does',
    };
  }

  try {
    if (mimeType === PDF_MIME) {
      inspectPdf(bytes);
    } else {
      await inspectDocx(bytes);
    }
  } catch (error) {
    return {
      status: 'rejected',
      reason: 'active_content',
      detail: error instanceof Error ? error.message : 'Document failed inspection',
    };
  }

  try {
    await scanner.scan(bytes, mimeType);
  } catch (error) {
    if (error instanceof ThreatDetectedError) {
      return { status: 'rejected', reason: 'malware_detected', detail: error.message };
    }
    return {
      status: 'rejected',
      reason: 'scan_unavailable',
      detail: error instanceof Error ? error.message : 'Malware scan could not complete',
    };
  }

  let text: string;
  let warnings: string[] = [];
  try {
    if (mimeType === PDF_MIME) {
      text = await extractPdfText(bytes, input.maxPages);
    } else {
      const extracted = await extractDocxText(bytes);
      text = extracted.text;
      warnings = extracted.warnings;
    }
  } catch (error) {
    return {
      status: 'rejected',
      reason: 'unreadable',
      detail: error instanceof Error ? error.message : 'Document text could not be extracted',
    };
  } finally {
    bytes.fill(0);
  }

  text = normaliseExtractedText(text);
  if (text.length < minimumCharacters) {
    return {
      status: 'rejected',
      reason: 'too_little_text',
      detail: 'The document contains too little extractable text to rely on',
    };
  }

  return { status: 'read', text, sha256, byteLength, mimeType, warnings };
}
