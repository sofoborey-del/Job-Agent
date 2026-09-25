/**
 * What the Discord command surface is allowed to do with an application. It is a narrow port on
 * purpose: the chat surface can view state and record workflow intent, and nothing here can start
 * a browser, fill a form or submit anything.
 */
export type ApplicationSummaryView = {
  applicationId: string;
  jobTitle: string;
  employer: string;
  stage: string;
  attemptStatus: string | null;
  pauseReason: string | null;
  openQuestions: number;
  manifestHashPrefix: string | null;
  approvalState: 'none' | 'approved' | 'rejected' | 'consumed';
  confirmationReference: string | null;
  takeoverRequested: boolean;
};

export type PausedQuestionView = {
  questionId: string;
  applicationId: string;
  prompt: string;
  reason: string;
  responseKind: 'text' | 'choice' | 'boolean' | 'number' | 'human_action';
  allowedValues: string[];
};

export type CommandResult = { ok: boolean; message: string };

export interface ApplicationCommandPort {
  list(limit: number): Promise<ApplicationSummaryView[]>;
  show(idPrefix: string): Promise<ApplicationSummaryView | null>;
  currentQuestion(idPrefix: string): Promise<PausedQuestionView | null>;
  /** The interaction id makes a replayed answer harmless. */
  answer(input: {
    idPrefix: string;
    value: string;
    saveToProfile: boolean;
    interactionId: string;
  }): Promise<CommandResult>;
  decide(input: {
    idPrefix: string;
    decision: 'approved' | 'rejected';
    manifestHashPrefix: string;
    reason: string | null;
    interactionId: string;
  }): Promise<CommandResult>;
  requestTakeover(idPrefix: string): Promise<CommandResult>;
  resume(idPrefix: string): Promise<CommandResult>;
}
