import type {
  Checkpoint,
  FieldIntent,
  ManifestAnswer,
  ReviewManifest,
} from '@job-agent/browser-core';
import type { ApplicationState } from '@job-agent/domain';

export type AttemptStatus =
  | 'running'
  | 'paused'
  | 'awaiting_approval'
  | 'submitting'
  | 'submitted'
  | 'submission_unknown'
  | 'failed'
  | 'cancelled';

export type ApplicationRecord = {
  id: string;
  userId: string;
  jobId: string;
  state: ApplicationState;
  stateVersion: number;
  submitMode: 'approval_required' | 'auto';
  targetKind: 'fake_ats';
  adapterId: string | null;
  adapterVersion: string | null;
  pauseReason: string | null;
  takeoverRequestedAt: string | null;
  currentAttemptNo: number;
  createdAt: string;
  updatedAt: string;
};

export type AttemptRecord = {
  id: string;
  applicationId: string;
  attemptNo: number;
  adapterId: string;
  adapterVersion: string;
  targetOrigin: string;
  status: AttemptStatus;
  pauseReason: string | null;
  checkpoint: Checkpoint | null;
  answerManifestHash: string | null;
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
  startedAt: string;
  finishedAt: string | null;
};

export type ApplicationFieldRecord = {
  id: string;
  attemptId: string;
  stepId: string;
  fieldKey: string;
  label: string;
  controlType: string;
  required: boolean;
  sensitive: boolean;
  mappedIntent: FieldIntent | null;
  mappingConfidence: number | null;
  answerSource:
    | 'verified_fact'
    | 'application_scoped_answer'
    | 'approved_document'
    | 'unresolved'
    | 'human_only'
    | 'not_applicable';
  answerHash: string | null;
  answerPreview: string | null;
  evidenceFactIds: string[];
  validationStatus: 'pending' | 'accepted' | 'rejected';
  validationMessage: string | null;
};

export type QuestionRecord = {
  id: string;
  applicationId: string;
  attemptId: string;
  stepId: string;
  fieldKey: string;
  reason: string;
  prompt: string;
  responseKind: 'text' | 'choice' | 'boolean' | 'number' | 'human_action';
  allowedValues: string[];
  state: 'open' | 'answered' | 'declined' | 'expired' | 'superseded';
  responseVersion: number;
  correlationId: string;
  expiresAt: string;
  createdAt: string;
  answeredAt: string | null;
};

export type ApprovalRecord = {
  id: string;
  applicationId: string;
  attemptId: string;
  snapshotHash: string;
  decision: 'approved' | 'rejected';
  reason: string | null;
  correlationId: string;
  createdAt: string;
  expiresAt: string;
  consumedAt: string | null;
};

export type SubmitIntentRecord = {
  id: string;
  applicationId: string;
  attemptId: string;
  approvalId: string;
  tokenHash: string;
  snapshotHash: string;
  targetOrigin: string;
  createdAt: string;
  expiresAt: string;
  consumedAt: string | null;
  result: 'submitted' | 'unknown' | 'failed' | null;
};

export type LedgerStatus = 'none' | 'reserved' | 'confirmed' | 'unknown' | 'released';

export type ReceiptRecord = {
  id: string;
  applicationId: string;
  attemptId: string;
  providerReference: string;
  capturedAt: string;
};

export type ArtifactRecord = {
  id: string;
  attemptId: string;
  kind: 'screenshot' | 'trace' | 'validation_log' | 'page_fingerprint';
  objectKey: string;
  sha256: string;
  redacted: boolean;
  bytes: number;
  retainUntil: string;
};

export type ApplicationOverview = {
  application: ApplicationRecord;
  attempt: AttemptRecord | null;
  openQuestions: QuestionRecord[];
  fields: ApplicationFieldRecord[];
  manifest: ReviewManifest | null;
  manifestHash: string | null;
  approval: ApprovalRecord | null;
  ledgerStatus: LedgerStatus;
  receipt: ReceiptRecord | null;
  artifacts: ArtifactRecord[];
};

export type { ManifestAnswer, ReviewManifest };
