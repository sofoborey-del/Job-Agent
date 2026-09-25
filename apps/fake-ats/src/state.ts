import { createHash, randomBytes } from 'node:crypto';

export type UploadedFile = {
  fieldName: string;
  filename: string;
  bytes: number;
  sha256: string;
  contentType: string;
};

export type FakeSession = {
  id: string;
  jobRef: string;
  createdAt: string;
  values: Record<string, string>;
  files: Record<string, UploadedFile>;
  employmentRows: number;
  educationRows: number;
  stepAttempts: Record<string, number>;
  completedSteps: string[];
  submitCount: number;
  reference: string | null;
  submittedAt: string | null;
};

export type FakeAtsControl = {
  /** Make the first submission of a step fail validation, to exercise the validation loop. */
  validationOnFirstAttempt: boolean;
  /** Artificial latency, in milliseconds, before any application response. */
  delayMs: number;
  /** Return a 500 for this step id, to exercise failure handling. */
  failOnStep: string | null;
  /** 'ambiguous' returns a page with no reference at all, so the caller cannot tell what happened. */
  submitOutcome: 'confirm' | 'ambiguous' | 'error';
  /** Add a new required control to the review page, simulating a form change after approval. */
  requireExtraFieldOnReview: boolean;
};

export const defaultControl: FakeAtsControl = {
  validationOnFirstAttempt: false,
  delayMs: 0,
  failOnStep: null,
  submitOutcome: 'confirm',
  requireExtraFieldOnReview: false,
};

export class FakeAtsStore {
  private readonly sessions = new Map<string, FakeSession>();
  control: FakeAtsControl = { ...defaultControl };

  create(jobRef: string): FakeSession {
    const session: FakeSession = {
      id: randomBytes(9).toString('hex'),
      jobRef,
      createdAt: new Date().toISOString(),
      values: {},
      files: {},
      employmentRows: 1,
      educationRows: 1,
      stepAttempts: {},
      completedSteps: [],
      submitCount: 0,
      reference: null,
      submittedAt: null,
    };
    this.sessions.set(session.id, session);
    return session;
  }

  get(id: string): FakeSession | null {
    return this.sessions.get(id) ?? null;
  }

  reset(): void {
    this.sessions.clear();
    this.control = { ...defaultControl };
  }

  /** Records exactly one submission per session, whatever the caller does. */
  recordSubmission(session: FakeSession): { first: boolean; reference: string } {
    session.submitCount += 1;
    if (session.reference === null) {
      session.reference = `FAKE-ATS-${createHash('sha256')
        .update(session.id)
        .digest('hex')
        .slice(0, 8)
        .toUpperCase()}`;
      session.submittedAt = new Date().toISOString();
      return { first: true, reference: session.reference };
    }
    return { first: false, reference: session.reference };
  }
}
