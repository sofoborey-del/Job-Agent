import JSZip from 'jszip';

const MAX_DOCX_UNCOMPRESSED_BYTES = 25 * 1024 * 1024;
const MAX_DOCX_ENTRIES = 500;

/**
 * True when the bytes actually begin as the declared type does. A declared content-type is a claim
 * made by whoever served the file, so it is checked against the bytes rather than trusted.
 */
export function hasExpectedSignature(bytes: Uint8Array, mimeType: string): boolean {
  if (mimeType === 'application/pdf') {
    return Buffer.from(bytes.subarray(0, 5)).toString('ascii') === '%PDF-';
  }
  return (
    mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' &&
    bytes[0] === 0x50 &&
    bytes[1] === 0x4b
  );
}

/**
 * Rejects a PDF that carries active or embedded content before any parser touches it. This is a
 * deliberately blunt byte-level check: it runs before extraction, not after.
 */
export function inspectPdf(bytes: Buffer): void {
  const source = bytes.toString('latin1');
  const forbidden = [/\/JavaScript\b/i, /\/JS\b/i, /\/EmbeddedFile\b/i, /\/Launch\b/i];
  if (forbidden.some((pattern) => pattern.test(source))) {
    throw new Error('PDF contains active or embedded content');
  }
}

/** Rejects a DOCX carrying macros, embedded objects, external relationships or a zip bomb. */
export async function inspectDocx(bytes: Buffer): Promise<void> {
  const zip = await JSZip.loadAsync(bytes, { checkCRC32: true, createFolders: false });
  const entries = Object.values(zip.files);
  if (entries.length > MAX_DOCX_ENTRIES) throw new Error('DOCX contains too many files');
  const forbiddenName = /(?:vbaProject\.bin|\/embeddings\/|\/activeX\/)/i;
  if (entries.some((entry) => forbiddenName.test(entry.name))) {
    throw new Error('DOCX contains active or embedded content');
  }

  let uncompressedBytes = 0;
  for (const entry of entries) {
    if (entry.dir) continue;
    const data = await entry.async('uint8array');
    uncompressedBytes += data.byteLength;
    if (uncompressedBytes > MAX_DOCX_UNCOMPRESSED_BYTES) {
      throw new Error('DOCX expands beyond the safety limit');
    }
    if (entry.name.endsWith('.rels')) {
      const relationships = Buffer.from(data).toString('utf8');
      if (/TargetMode\s*=\s*["']External["']/i.test(relationships)) {
        throw new Error('DOCX contains external relationships');
      }
    }
  }
}
