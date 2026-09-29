import type { RealSiteApprovedDocument } from '@job-agent/browser-core';
import type { KnowledgeFact } from '@job-agent/domain';

import type { VerifiedEmailInstruction } from './instruction.js';
import type { EmailReviewManifest } from './manifest.js';

export const emailApplicationStates = [
  'awaiting_approval',
  'approved',
  'sending',
  'sent',
  'send_uncertain',
  'failed',
  'rejected',
] as const;
export type EmailApplicationState = (typeof emailApplicationStates)[number];

export type EmailApplicationRecord = {
  id: string;
  userId: string;
  jobId: string;
  state: EmailApplicationState;
  recipient: string;
  recipientDomain: string;
  subject: string;
  bodySha256: string;
  bodyCharacters: number;
  attachment: { documentId: string; filename: string; sha256: string } | null;
  manifestHash: string;
  manifest: EmailReviewManifest;
  instruction: VerifiedEmailInstruction;
  jobVersion: number;
  jobContentHash: string;
  closesAt: string | null;
  salaryGate: 'pass' | 'reject' | 'unknown';
  salaryOverride: boolean;
  failureCode: string | null;
  createdAt: string;
  updatedAt: string;
};

export type EmailApprovalRecord = {
  id: string;
  emailApplicationId: string;
  manifestHash: string;
  decision: 'approved' | 'rejected';
  approverChannel: 'discord' | 'local';
  reason: string | null;
  requestId: string | null;
  correlationId: string;
  createdAt: string;
  expiresAt: string;
  consumedAt: string | null;
};

export type EmailLedgerStatus = 'none' | 'reserved' | 'sent' | 'uncertain' | 'released';

export type EmailReceiptRecord = {
  emailApplicationId: string;
  provider: string;
  providerMessageId: string;
  providerThreadId: string | null;
  evidenceSource: 'provider_receipt' | 'user_report';
  acceptedAt: string;
};

export type SaveDraftInput = {
  userId: string;
  jobId: string;
  recipient: string;
  recipientDomain: string;
  subject: string;
  bodyCiphertext: Buffer;
  bodySha256: string;
  bodyCharacters: number;
  attachment: { documentId: string; filename: string; sha256: string };
  manifestHash: string;
  manifest: EmailReviewManifest;
  instruction: VerifiedEmailInstruction;
  jobVersion: number;
  jobContentHash: string;
  closesAt: string | null;
  salaryGate: 'pass' | 'reject' | 'unknown';
  salaryOverride: boolean;
  now: Date;
};

export interface EmailApplicationRepository {
  /**
   * Writes the reviewable draft for one vacancy. One row per (user, job): preparing again replaces
   * the draft, which is what makes a superseded review's hash stop matching.
   */
  saveDraft(input: SaveDraftInput): Promise<EmailApplicationRecord>;
  get(id: string): Promise<EmailApplicationRecord | null>;
  findByJob(userId: string, jobId: string): Promise<EmailApplicationRecord | null>;
  list(userId: string, limit: number): Promise<EmailApplicationRecord[]>;
  /** The encrypted body. Decryption happens in the service, once, at send time. */
  readBodyCiphertext(id: string): Promise<Buffer | null>;
  setState(input: {
    id: string;
    state: EmailApplicationState;
    failureCode?: string | null;
    now: Date;
  }): Promise<EmailApplicationRecord>;
  /**
   * Records a decision. Idempotent on `requestId`: a replayed chat command returns the decision the
   * first one produced rather than recording a second.
   */
  recordDecision(input: {
    emailApplicationId: string;
    manifestHash: string;
    decision: 'approved' | 'rejected';
    approverChannel: 'discord' | 'local';
    reason: string | null;
    requestId: string | null;
    correlationId: string;
    ttlSeconds: number;
    now: Date;
  }): Promise<{ created: boolean; approval: EmailApprovalRecord }>;
  /**
   * The decision a given chat interaction already produced, if any.
   *
   * Looked up before anything else, so a command that arrives twice is recognised as the same
   * command whatever state its application has since reached. Without this, a replayed approval
   * would be answered as though it were a fresh one that arrived too late.
   */
  decisionByRequestId(requestId: string): Promise<EmailApprovalRecord | null>;
  liveApproval(
    emailApplicationId: string,
    manifestHash: string,
  ): Promise<EmailApprovalRecord | null>;
  /** One-use. Returns false when the approval was already consumed. */
  consumeApproval(approvalId: string, now: Date): Promise<boolean>;
  /**
   * Reserves the single send permitted for this application, inside the day's cap. The ledger row
   * is the durable guarantee: once it exists, no second send can be started for this vacancy, even
   * across a restart.
   */
  reserveSend(input: {
    userId: string;
    emailApplicationId: string;
    approvalId: string;
    localDate: string;
    dailyCap: number;
    now: Date;
  }): Promise<{
    reserved: boolean;
    status: EmailLedgerStatus;
    usedToday: number;
    capReached: boolean;
  }>;
  resolveSend(input: {
    emailApplicationId: string;
    status: 'sent' | 'uncertain' | 'released';
    now: Date;
  }): Promise<void>;
  ledgerStatus(emailApplicationId: string): Promise<EmailLedgerStatus>;
  recordReceipt(input: {
    emailApplicationId: string;
    provider: string;
    providerMessageId: string;
    providerThreadId: string | null;
    evidenceSource: 'provider_receipt' | 'user_report';
    acceptedAt: Date;
    now: Date;
  }): Promise<EmailReceiptRecord>;
  receipt(emailApplicationId: string): Promise<EmailReceiptRecord | null>;
}

/** Everything about a vacancy that the gates need, read from the tracker rather than the network. */
export type EmailApplicationJobView = {
  jobId: string;
  title: string;
  employer: string;
  canonicalUrl: string;
  description: string;
  personSpecificationText: string | null;
  closesAt: string | null;
  jobVersion: number;
  jobContentHash: string;
  lifecycleStatus: string;
  descriptionCompleteness: 'full' | 'snippet';
  salaryGate: 'pass' | 'reject' | 'unknown';
  hardRejectReasons: readonly string[];
  /** Non-null when this vacancy is already recorded as applied for, by any route. */
  externalSubmissionReference: string | null;
};

export interface EmailApplicationJobSource {
  load(userId: string, jobId: string): Promise<EmailApplicationJobView | null>;
  /**
   * Records that this vacancy has now been applied for, so every other surface — the tracker, the
   * answer pack, the preparation view — treats it as done and no second application can start.
   */
  markApplied(input: {
    userId: string;
    jobId: string;
    providerReference: string;
    submittedAt: Date;
    correlationId: string;
  }): Promise<void>;
}

export interface EmailApplicationProfileSource {
  facts(userId: string): Promise<readonly KnowledgeFact<unknown>[]>;
  approvedDocumentReference(userId: string): Promise<RealSiteApprovedDocument | null>;
  /** The approved CV's bytes. Called once, at send time, and never logged or returned. */
  approvedUpload(userId: string): Promise<{
    documentId: string;
    sha256: string;
    filename: string;
    contentBase64: string;
  } | null>;
}

export type ReviewNotification = {
  emailApplicationId: string;
  manifestHash: string;
  /** Already split into messages a chat service will accept whole. */
  chunks: readonly string[];
};

export type OutcomeNotification = {
  emailApplicationId: string;
  jobId: string;
  title: string;
  employer: string;
  /** The recipient's domain only. The full address is applicant-adjacent and stays out of logs. */
  recipientDomain: string;
  detail: string;
};

/**
 * Notifications. Everything except the review itself carries identifiers, a job title and a domain:
 * no address, no body, no fact value. The review is the one deliberate exception, because approving
 * a message you cannot read is not approval, and even that is stored by reference and only rendered
 * at delivery.
 */
export interface EmailApplicationNotifier {
  reviewReady(notification: ReviewNotification): Promise<void>;
  sent(notification: OutcomeNotification & { providerReference: string }): Promise<void>;
  uncertain(notification: OutcomeNotification): Promise<void>;
  failed(notification: OutcomeNotification & { errorCode: string }): Promise<void>;
}

export type EmailAuditEntry = {
  userId: string;
  action: string;
  jobId: string;
  result: 'allowed' | 'denied' | 'succeeded' | 'failed';
  correlationId: string;
  /** Identifiers, codes and counts only. Never an address, a body or a fact value. */
  metadata: Record<string, unknown>;
};

export interface EmailApplicationAuditSink {
  append(entry: EmailAuditEntry): Promise<void>;
}
