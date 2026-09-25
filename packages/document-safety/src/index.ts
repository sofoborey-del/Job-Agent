export {
  DOCX_MIME,
  PDF_MIME,
  ThreatDetectedError,
  WindowsDefenderScanner,
  type MalwareScanner,
  type SafeDocumentMimeType,
} from './scanner.js';
export { hasExpectedSignature, inspectDocx, inspectPdf } from './inspect.js';
export {
  MAX_EXTRACTED_CHARACTERS,
  extractDocxText,
  extractPdfText,
  normaliseExtractedText,
} from './extract.js';
export { readDocumentSafely, type DocumentRejectionReason, type SafeDocumentRead } from './read.js';
