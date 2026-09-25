import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { EncryptedEnvelope, FieldCipher } from '@job-agent/security';
import { decodeEnvelope, encodeEnvelope } from '@job-agent/security';
import { v7 as uuidv7 } from 'uuid';

const MAX_CV_BYTES = 5 * 1024 * 1024;
const PDF = 'application/pdf';
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

export type StoredDocument = {
  id: string;
  userId: string;
  type: 'cv';
  version: number;
  objectKey: string;
  sha256: string;
  mimeType: typeof PDF | typeof DOCX;
  approved: boolean;
  malwareScanStatus: 'pending' | 'clean' | 'rejected' | 'error';
};

export interface DocumentRepository {
  nextDocumentVersion(userId: string, type: StoredDocument['type']): Promise<number>;
  saveDocument(document: StoredDocument): Promise<void>;
  getLatestDocument(userId: string, type: StoredDocument['type']): Promise<StoredDocument | null>;
  setDocumentScanStatus(
    documentId: string,
    userId: string,
    status: StoredDocument['malwareScanStatus'],
  ): Promise<void>;
  approveDocument(documentId: string, userId: string): Promise<void>;
}

export interface EncryptedArtifactStore {
  put(objectKey: string, envelope: EncryptedEnvelope): Promise<void>;
  get(objectKey: string): Promise<EncryptedEnvelope>;
  delete(objectKey: string): Promise<void>;
}

export class LocalEncryptedArtifactStore implements EncryptedArtifactStore {
  constructor(private readonly rootDirectory: string) {}

  private resolve(objectKey: string): string {
    if (!/^[0-9a-f-]+\/[0-9a-f-]+\.enc$/.test(objectKey)) {
      throw new Error('Invalid artifact object key');
    }
    const root = path.resolve(this.rootDirectory);
    const resolved = path.resolve(root, objectKey);
    if (!resolved.startsWith(root + path.sep)) throw new Error('Artifact path escaped its root');
    return resolved;
  }

  async put(objectKey: string, envelope: EncryptedEnvelope): Promise<void> {
    const target = this.resolve(objectKey);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, encodeEnvelope(envelope), { flag: 'wx', mode: 0o600 });
  }

  async delete(objectKey: string): Promise<void> {
    await rm(this.resolve(objectKey), { force: true });
  }

  async get(objectKey: string): Promise<EncryptedEnvelope> {
    return decodeEnvelope(await readFile(this.resolve(objectKey)));
  }
}

export class InMemoryArtifactStore implements EncryptedArtifactStore {
  readonly artifacts = new Map<string, EncryptedEnvelope>();

  put(objectKey: string, envelope: EncryptedEnvelope): Promise<void> {
    if (this.artifacts.has(objectKey)) throw new Error('Artifact already exists');
    this.artifacts.set(objectKey, envelope);
    return Promise.resolve();
  }

  delete(objectKey: string): Promise<void> {
    this.artifacts.delete(objectKey);
    return Promise.resolve();
  }

  get(objectKey: string): Promise<EncryptedEnvelope> {
    const envelope = this.artifacts.get(objectKey);
    if (envelope === undefined) throw new Error('Artifact does not exist');
    return Promise.resolve(envelope);
  }
}

function hasExpectedSignature(bytes: Uint8Array, mimeType: string): boolean {
  if (mimeType === PDF) return Buffer.from(bytes.subarray(0, 5)).toString('ascii') === '%PDF-';
  return mimeType === DOCX && bytes[0] === 0x50 && bytes[1] === 0x4b;
}

export class DocumentService {
  constructor(
    private readonly repository: DocumentRepository,
    private readonly artifacts: EncryptedArtifactStore,
    private readonly cipher: FieldCipher,
  ) {}

  async uploadCv(input: {
    userId: string;
    fileName: string;
    mimeType: string;
    bytes: Uint8Array;
    confirmed: boolean;
  }): Promise<Omit<StoredDocument, 'objectKey'>> {
    if (!input.confirmed) throw new Error('CV upload must be explicitly confirmed');
    if (input.bytes.length === 0 || input.bytes.length > MAX_CV_BYTES) {
      throw new Error('CV must be between 1 byte and 5 MB');
    }
    if (input.mimeType !== PDF && input.mimeType !== DOCX) {
      throw new Error('CV must be a PDF or DOCX file');
    }
    if (!hasExpectedSignature(input.bytes, input.mimeType)) {
      throw new Error('CV file content does not match its declared type');
    }
    if (path.basename(input.fileName) !== input.fileName || input.fileName.length > 200) {
      throw new Error('CV filename is invalid');
    }

    const id = uuidv7();
    const version = await this.repository.nextDocumentVersion(input.userId, 'cv');
    const sha256 = createHash('sha256').update(input.bytes).digest('hex');
    const objectKey = `${input.userId}/${id}.enc`;
    const document: StoredDocument = {
      id,
      userId: input.userId,
      type: 'cv',
      version,
      objectKey,
      sha256,
      mimeType: input.mimeType,
      approved: false,
      malwareScanStatus: 'pending',
    };
    const associatedData = [input.userId, id, 'cv', String(version), sha256].join('|');
    await this.artifacts.put(objectKey, this.cipher.encryptBytes(input.bytes, associatedData));
    try {
      await this.repository.saveDocument(document);
    } catch (error) {
      await this.artifacts.delete(objectKey);
      throw error;
    }
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
}

export class InMemoryDocumentRepository implements DocumentRepository {
  readonly documents: StoredDocument[] = [];

  nextDocumentVersion(userId: string): Promise<number> {
    return Promise.resolve(
      Math.max(
        0,
        ...this.documents
          .filter((document) => document.userId === userId)
          .map((document) => document.version),
      ) + 1,
    );
  }

  saveDocument(document: StoredDocument): Promise<void> {
    this.documents.push(document);
    return Promise.resolve();
  }

  getLatestDocument(userId: string): Promise<StoredDocument | null> {
    const documents = this.documents
      .filter((document) => document.userId === userId)
      .sort((left, right) => right.version - left.version);
    return Promise.resolve(documents[0] ?? null);
  }

  setDocumentScanStatus(
    documentId: string,
    userId: string,
    status: StoredDocument['malwareScanStatus'],
  ): Promise<void> {
    const document = this.documents.find(
      (candidate) => candidate.id === documentId && candidate.userId === userId,
    );
    if (document === undefined) throw new Error('CV document not found');
    document.malwareScanStatus = status;
    return Promise.resolve();
  }

  approveDocument(documentId: string, userId: string): Promise<void> {
    const document = this.documents.find(
      (candidate) => candidate.id === documentId && candidate.userId === userId,
    );
    if (document === undefined) throw new Error('CV document not found');
    if (document.malwareScanStatus !== 'clean') throw new Error('CV has not passed safety checks');
    document.approved = true;
    return Promise.resolve();
  }
}
