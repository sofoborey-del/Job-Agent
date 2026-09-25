import { randomBytes } from 'node:crypto';

import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';

import { FieldCipher, StaticEncryptionKeyProvider } from '@job-agent/security';

import { DocumentService, InMemoryArtifactStore, InMemoryDocumentRepository } from './documents.js';
import { CvProcessingService } from './cv-processing.js';

function createFixture(): {
  service: DocumentService;
  repository: InMemoryDocumentRepository;
  artifacts: InMemoryArtifactStore;
  processor: CvProcessingService;
} {
  const repository = new InMemoryDocumentRepository();
  const artifacts = new InMemoryArtifactStore();
  const cipher = new FieldCipher(
    new StaticEncryptionKeyProvider('test-v1', new Map([['test-v1', randomBytes(32)]])),
  );
  return {
    service: new DocumentService(repository, artifacts, cipher),
    repository,
    artifacts,
    processor: new CvProcessingService(repository, artifacts, cipher, {
      scan: () => Promise.resolve(),
    }),
  };
}

async function syntheticDocx(): Promise<Buffer> {
  const zip = new JSZip();
  zip.file(
    '[Content_Types].xml',
    '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
  );
  zip.file(
    '_rels/.rels',
    '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
  );
  zip.file(
    'word/document.xml',
    '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Employment History</w:t></w:r></w:p><w:p><w:r><w:t>Example Council - Adviser - 2021 to present</w:t></w:r></w:p><w:p><w:r><w:t>Education</w:t></w:r></w:p><w:p><w:r><w:t>Example College - Certificate</w:t></w:r></w:p><w:p><w:r><w:t>Skills</w:t></w:r></w:p><w:p><w:r><w:t>Customer service and complaint handling</w:t></w:r></w:p></w:body></w:document>',
  );
  return zip.generateAsync({ type: 'nodebuffer' });
}

describe('CV document intake', () => {
  it('encrypts an uploaded CV and leaves it quarantined', async () => {
    const { service, repository, artifacts } = createFixture();
    const result = await service.uploadCv({
      userId: '0199-0000-7000-8000-000000000000',
      fileName: 'cv.pdf',
      mimeType: 'application/pdf',
      bytes: Buffer.from('%PDF-1.7 safe synthetic data'),
      confirmed: true,
    });
    expect(result).toMatchObject({ approved: false, malwareScanStatus: 'pending', version: 1 });
    expect(repository.documents).toHaveLength(1);
    expect(artifacts.artifacts.size).toBe(1);
    const encodedArtifact = JSON.stringify([...artifacts.artifacts.values()]);
    expect(encodedArtifact).not.toContain('safe synthetic data');
  });

  it('rejects mismatched and unconfirmed uploads', async () => {
    const { service } = createFixture();
    await expect(
      service.uploadCv({
        userId: '0199-0000-7000-8000-000000000000',
        fileName: 'cv.pdf',
        mimeType: 'application/pdf',
        bytes: Buffer.from('not a PDF'),
        confirmed: true,
      }),
    ).rejects.toThrow('does not match');
    await expect(
      service.uploadCv({
        userId: '0199-0000-7000-8000-000000000000',
        fileName: 'cv.pdf',
        mimeType: 'application/pdf',
        bytes: Buffer.from('%PDF-1.7'),
        confirmed: false,
      }),
    ).rejects.toThrow('explicitly confirmed');
  });

  it('checks, extracts, and explicitly approves a DOCX CV', async () => {
    const { service, processor } = createFixture();
    const userId = '0199-0000-7000-8000-000000000000';
    const uploaded = await service.uploadCv({
      userId,
      fileName: 'cv.docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      bytes: await syntheticDocx(),
      confirmed: true,
    });
    const review = await processor.processLatest(userId);
    expect(review.scanStatus).toBe('clean');
    expect(review.sections.employment).toContain('Example Council');
    expect(review.sections.education).toContain('Example College');
    expect(review.sections.skills).toContain('Customer service');
    const approved = await processor.approve({
      userId,
      documentId: uploaded.id,
      expectedSha256: uploaded.sha256,
      confirmed: true,
    });
    expect(approved.approved).toBe(true);
  });
});
