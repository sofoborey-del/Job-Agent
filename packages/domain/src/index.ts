export type Currency = 'GBP';

export type Money = {
  amountMinor: number;
  currency: Currency;
};

export type AnnualSalary = {
  basis: 'annual_base';
  minimum?: Money;
  maximum?: Money;
  confidence: number;
  sourceText: string;
};

export type RequirementCategory =
  | 'qualification'
  | 'experience'
  | 'skill'
  | 'licence'
  | 'work_authorisation'
  | 'location'
  | 'availability'
  | 'other';

export type JobRequirement = {
  id: string;
  category: RequirementCategory;
  text: string;
  mandatory: boolean;
  evidenceExcerpt: string;
  extractionConfidence: number;
};

export type RequirementOutcome = 'met' | 'not_met' | 'unknown' | 'not_applicable';

export type RequirementMatch = {
  requirementId: string;
  outcome: RequirementOutcome;
  evidenceFactIds: string[];
  confidence: number;
  explanation: string;
};

export type SitePolicyDecision =
  'auto_submit_allowed' | 'prefill_only' | 'manual_only' | 'disabled' | 'unknown' | 'expired';

export type MatchDimensions = {
  mandatoryCoverage: number;
  relevantSkills: number;
  relevantExperience: number;
  locationFit: number;
  compensationQuality: number;
  otherPreferences: number;
};

export type MatchAction = 'reject' | 'shortlist' | 'prefill_with_approval' | 'auto_apply';

export type MatchDecision = {
  action: MatchAction;
  score: number;
  evidenceCoverage: number;
  decisionConfidence: number;
  hardRejectReasons: string[];
  autoBlockers: string[];
  explanation: string[];
};

export type KnowledgeFactStatus = 'verified' | 'unverified' | 'unknown' | 'declined';
export type FactSensitivity = 'normal' | 'personal' | 'high_risk';
export type FactUsePolicy = 'auto_fill' | 'ask_each_time' | 'never_auto_fill';

export type KnowledgeFact<T> = {
  id: string;
  key: string;
  value: T | null;
  status: KnowledgeFactStatus;
  source: 'user' | 'cv' | 'document' | 'derived';
  sourceRef?: string;
  verifiedAt?: string;
  expiresAt?: string;
  sensitivity: FactSensitivity;
  usePolicy: FactUsePolicy;
  allowedPurposes: Array<'matching' | 'application' | 'reporting'>;
  version: number;
};

export const APPLICATION_STATES = [
  'DISCOVERED',
  'NORMALIZED',
  'REJECTED',
  'SCORED',
  'SHORTLISTED',
  'QUEUED',
  'STARTING',
  'FILLING',
  'WAITING_USER',
  'WAITING_TAKEOVER',
  'READY_FOR_REVIEW',
  'WAITING_APPROVAL',
  'READY_TO_SUBMIT',
  'SUBMITTING',
  'SUBMITTED',
  'SUBMISSION_UNKNOWN',
  'RETRYABLE_FAILED',
  'PERMANENT_FAILED',
  'CANCELLED',
  'FOLLOW_UP',
  'CLOSED',
] as const;

export type ApplicationState = (typeof APPLICATION_STATES)[number];

export type ApplicationEvent = {
  applicationId: string;
  sequence: number;
  from: ApplicationState | null;
  to: ApplicationState;
  actor: 'user' | 'system' | 'worker';
  reason: string;
  occurredAt: string;
  correlationId: string;
};
