import type { Checkpoint } from '@job-agent/browser-core';
import type { ApplicationState } from '@job-agent/domain';

import type {
  ApplicationFieldRecord,
  ApplicationRecord,
  ApprovalRecord,
  ArtifactRecord,
  AttemptRecord,
  AttemptStatus,
  LedgerStatus,
  QuestionRecord,
  ReceiptRecord,
  SubmitIntentRecord,
} from './types.js';

export interface ApplicationRepository {
  create(input: {
    userId: string;
    jobId: string;
    matchRunId: string | null;
    policyVersion: string;
    adapterId: string;
    adapterVersion: string;
    correlationId: string;
    now: Date;
  }): Promise<ApplicationRecord>;
  get(applicationId: string): Promise<ApplicationRecord | null>;
  findByJob(userId: string, jobId: string): Promise<ApplicationRecord | null>;
  list(userId: string, limit: number): Promise<ApplicationRecord[]>;
  transition(input: {
    applicationId: string;
    to: ApplicationState;
    actor: 'user' | 'system' | 'worker';
    reason: string;
    correlationId: string;
    pauseReason?: string | null;
    now: Date;
  }): Promise<ApplicationRecord>;
  setTakeover(input: {
    applicationId: string;
    requested: boolean;
    correlationId: string;
    now: Date;
  }): Promise<ApplicationRecord>;
}

export interface AttemptRepository {
  create(input: {
    applicationId: string;
    adapterId: string;
    adapterVersion: string;
    targetOrigin: string;
    now: Date;
  }): Promise<AttemptRecord>;
  get(attemptId: string): Promise<AttemptRecord | null>;
  current(applicationId: string): Promise<AttemptRecord | null>;
  saveCheckpoint(input: {
    attemptId: string;
    checkpoint: Checkpoint;
    status: AttemptStatus;
    pauseReason: string | null;
    now: Date;
  }): Promise<void>;
  setStatus(input: {
    attemptId: string;
    status: AttemptStatus;
    pauseReason: string | null;
    now: Date;
  }): Promise<void>;
  setManifestHash(attemptId: string, manifestHash: string, now: Date): Promise<void>;
  acquireLease(input: {
    attemptId: string;
    owner: string;
    seconds: number;
    now: Date;
  }): Promise<boolean>;
  releaseLease(attemptId: string): Promise<void>;
}

export interface ApplicationFieldRepository {
  replaceStep(input: {
    attemptId: string;
    stepId: string;
    fields: Array<
      Omit<ApplicationFieldRecord, 'id' | 'attemptId'> & { answerCiphertext: Buffer | null }
    >;
    now: Date;
  }): Promise<void>;
  list(attemptId: string): Promise<ApplicationFieldRecord[]>;
  readAnswers(attemptId: string): Promise<Array<{ fieldKey: string; ciphertext: Buffer | null }>>;
  markValidation(input: {
    attemptId: string;
    stepId: string;
    messages: string[];
    now: Date;
  }): Promise<void>;
}

export interface QuestionRepository {
  open(input: {
    applicationId: string;
    attemptId: string;
    stepId: string;
    fieldKey: string;
    reason: string;
    prompt: string;
    responseKind: QuestionRecord['responseKind'];
    allowedValues: string[];
    correlationId: string;
    expiresAt: Date;
    now: Date;
  }): Promise<QuestionRecord>;
  listOpen(applicationId: string): Promise<QuestionRecord[]>;
  get(questionId: string): Promise<QuestionRecord | null>;
  /** Idempotent on (questionId, responseVersion): a replayed answer returns the first result. */
  answer(input: {
    questionId: string;
    responseVersion: number;
    ciphertext: Buffer;
    scope: 'application_only' | 'save_to_profile';
    now: Date;
  }): Promise<{ applied: boolean; question: QuestionRecord }>;
  supersedeOpen(attemptId: string, now: Date): Promise<number>;
  readAnswers(attemptId: string): Promise<Array<{ fieldKey: string; ciphertext: Buffer }>>;
}

export interface ApprovalRepository {
  record(input: {
    applicationId: string;
    attemptId: string;
    snapshotHash: string;
    decision: 'approved' | 'rejected';
    reason: string | null;
    correlationId: string;
    ttlSeconds: number;
    now: Date;
  }): Promise<{ created: boolean; approval: ApprovalRecord }>;
  liveApproval(applicationId: string, snapshotHash: string): Promise<ApprovalRecord | null>;
  latest(applicationId: string): Promise<ApprovalRecord | null>;
  consume(approvalId: string, now: Date): Promise<boolean>;
}

export interface SubmitIntentRepository {
  issue(input: {
    applicationId: string;
    attemptId: string;
    approvalId: string;
    tokenHash: string;
    snapshotHash: string;
    targetOrigin: string;
    expiresAt: Date;
    now: Date;
  }): Promise<SubmitIntentRecord>;
  active(attemptId: string): Promise<SubmitIntentRecord | null>;
  consume(input: {
    intentId: string;
    result: 'submitted' | 'unknown' | 'failed';
    now: Date;
  }): Promise<boolean>;
}

export interface SubmissionLedgerRepository {
  reserve(input: {
    userId: string;
    applicationId: string;
    attemptId: string;
    idempotencyKey: string;
    localDate: string;
    now: Date;
  }): Promise<{ reserved: boolean; status: LedgerStatus }>;
  status(applicationId: string): Promise<LedgerStatus>;
  resolve(input: {
    applicationId: string;
    status: 'confirmed' | 'unknown' | 'released';
    now: Date;
  }): Promise<void>;
}

export interface ReceiptRepository {
  record(input: {
    applicationId: string;
    attemptId: string;
    providerReference: string;
    confirmationUrlHash: string | null;
    now: Date;
  }): Promise<ReceiptRecord>;
  get(applicationId: string): Promise<ReceiptRecord | null>;
}

export interface BrowserArtifactRepository {
  record(input: {
    attemptId: string;
    kind: ArtifactRecord['kind'];
    objectKey: string;
    sha256: string;
    bytes: number;
    retainUntil: Date;
    now: Date;
  }): Promise<void>;
  list(attemptId: string): Promise<ArtifactRecord[]>;
}

export type ApplicationStores = {
  applications: ApplicationRepository;
  attempts: AttemptRepository;
  fields: ApplicationFieldRepository;
  questions: QuestionRepository;
  approvals: ApprovalRepository;
  submitIntents: SubmitIntentRepository;
  ledger: SubmissionLedgerRepository;
  receipts: ReceiptRepository;
  artifacts: BrowserArtifactRepository;
};
