import { createHash } from 'node:crypto';

import {
  extractDocxText,
  extractPdfText,
  inspectDocx,
  inspectPdf,
  normaliseExtractedText,
} from '@job-agent/document-safety';
import type { FieldCipher } from '@job-agent/security';

import type { DocumentRepository, EncryptedArtifactStore, StoredDocument } from './documents.js';
import type { MalwareScanner } from './defender-scanner.js';
import { ThreatDetectedError } from './defender-scanner.js';

const PDF = 'application/pdf';

export type CvSections = {
  employment: string;
  education: string;
  skills: string;
  qualifications: string;
};

export type CvReview = {
  documentId: string;
  version: number;
  sha256: string;
  mimeType: StoredDocument['mimeType'];
  scanStatus: 'clean';
  fullText: string;
  sections: CvSections;
  warnings: string[];
};

function safeDocument(document: StoredDocument): Omit<StoredDocument, 'objectKey'> {
  return {
    id: document.id,
    userId: document.userId,
    type: document.type,
    version: document.version,
    sha256: document.sha256,
    mimeType: document.mimeType,
    approved: document.approved,
    malwareScanStatus: document.malwareScanStatus,
  };
}

function artifactAssociatedData(document: StoredDocument): string {
  return [
    document.userId,
    document.id,
    document.type,
    String(document.version),
    document.sha256,
  ].join('|');
}

const sectionHeadings: Record<keyof CvSections, RegExp> = {
  employment:
    /^(employment|employment history|work history|work experience|professional experience|career history)$/i,
  education:
    /^(education|education history|academic history|academic qualifications|education (?:and|&) qualifications|qualifications (?:and|&) education)$/i,
  skills: /^(skills|key skills|core skills|technical skills|competencies|core competencies)$/i,
  qualifications:
    /^(qualifications|certifications|certificates|licences|licenses|professional qualifications|training (?:and|&) qualifications|professional development)$/i,
};

function extractSections(text: string): CvSections {
  const sections: CvSections = { employment: '', education: '', skills: '', qualifications: '' };
  let current: keyof CvSections | null = null;
  for (const line of text.split('\n')) {
    const trimmed = line.trim().replace(/:$/, '');
    const heading = (Object.keys(sectionHeadings) as Array<keyof CvSections>).find((key) =>
      sectionHeadings[key].test(trimmed),
    );
    if (heading !== undefined) {
      current = heading;
      continue;
    }
    if (current !== null) sections[current] += (sections[current] === '' ? '' : '\n') + line;
  }
  for (const key of Object.keys(sections) as Array<keyof CvSections>) {
    sections[key] = sections[key].trim();
  }
  return sections;
}

export class CvProcessingService {
  constructor(
    private readonly repository: DocumentRepository,
    private readonly artifacts: EncryptedArtifactStore,
    private readonly cipher: FieldCipher,
    private readonly malwareScanner: MalwareScanner,
  ) {}

  async latest(userId: string): Promise<Omit<StoredDocument, 'objectKey'> | null> {
    const document = await this.repository.getLatestDocument(userId, 'cv');
    if (document === null) return null;
    return safeDocument(document);
  }

  /**
   * The approved CV's identity, without its bytes.
   *
   * The preparation screen needs to tell the person which file to attach and prove it is the one
   * they approved. It must not receive the document itself, so this returns the reference only and
   * `approvedUpload` stays the single path that decrypts anything.
   */
  async approvedDocumentReference(
    userId: string,
  ): Promise<{ documentId: string; sha256: string; filename: string } | null> {
    const document = await this.repository.getLatestDocument(userId, 'cv');
    if (document?.approved !== true) return null;
    return {
      documentId: document.id,
      sha256: document.sha256,
      filename: document.mimeType === PDF ? 'cv.pdf' : 'cv.docx',
    };
  }

  /**
   * The approved CV, ready to upload to a form. It returns nothing unless the document has been
   * explicitly approved, and it re-checks the hash before handing the bytes out, so an artifact
   * changed underneath the record cannot be uploaded in place of the reviewed one.
   *
   * The bytes are returned only to the caller that uploads them; they are never logged, never put
   * in an API response and never placed in model context.
   */
  async approvedUpload(userId: string): Promise<{
    documentId: string;
    sha256: string;
    filename: string;
    contentBase64: string;
  } | null> {
    const document = await this.repository.getLatestDocument(userId, 'cv');
    if (document?.approved !== true) return null;
    const envelope = await this.artifacts.get(document.objectKey);
    const bytes = this.cipher.decryptBytes(envelope, artifactAssociatedData(document));
    if (createHash('sha256').update(bytes).digest('hex') !== document.sha256) {
      throw new Error('CV integrity check failed');
    }
    return {
      documentId: document.id,
      sha256: document.sha256,
      filename: document.mimeType === PDF ? 'cv.pdf' : 'cv.docx',
      contentBase64: bytes.toString('base64'),
    };
  }

  async processLatest(userId: string): Promise<CvReview> {
    const document = await this.repository.getLatestDocument(userId, 'cv');
    if (document === null) throw new Error('No CV has been uploaded');
    const envelope = await this.artifacts.get(document.objectKey);
    const bytes = this.cipher.decryptBytes(envelope, artifactAssociatedData(document));
    try {
      const actualHash = createHash('sha256').update(bytes).digest('hex');
      if (actualHash !== document.sha256) throw new Error('CV integrity check failed');

      let text: string;
      let warnings: string[] = [];
      if (document.mimeType === PDF) {
        inspectPdf(bytes);
      } else {
        await inspectDocx(bytes);
      }
      await this.malwareScanner.scan(bytes, document.mimeType);
      if (document.mimeType === PDF) {
        text = await extractPdfText(bytes);
      } else {
        const extracted = await extractDocxText(bytes);
        text = extracted.text;
        warnings = extracted.warnings;
      }
      text = normaliseExtractedText(text);
      if (text.length < 20) throw new Error('The CV contains too little extractable text');
      await this.repository.setDocumentScanStatus(document.id, userId, 'clean');
      return {
        documentId: document.id,
        version: document.version,
        sha256: document.sha256,
        mimeType: document.mimeType,
        scanStatus: 'clean',
        fullText: text,
        sections: extractSections(text),
        warnings,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'CV processing failed';
      const rejected =
        error instanceof ThreatDetectedError ||
        /active|embedded|external|safety|integrity/i.test(message);
      await this.repository.setDocumentScanStatus(
        document.id,
        userId,
        rejected ? 'rejected' : 'error',
      );
      throw error;
    } finally {
      bytes.fill(0);
    }
  }

  async approve(input: {
    userId: string;
    documentId: string;
    expectedSha256: string;
    confirmed: boolean;
  }): Promise<Omit<StoredDocument, 'objectKey'>> {
    if (!input.confirmed) throw new Error('CV approval must be explicitly confirmed');
    const document = await this.repository.getLatestDocument(input.userId, 'cv');
    if (document === null) throw new Error('No CV has been uploaded');
    if (document.id !== input.documentId || document.sha256 !== input.expectedSha256) {
      throw new Error('CV approval does not match the latest uploaded document');
    }
    if (document.malwareScanStatus !== 'clean') throw new Error('CV has not passed safety checks');
    await this.repository.approveDocument(document.id, input.userId);
    return safeDocument({ ...document, approved: true });
  }
}
