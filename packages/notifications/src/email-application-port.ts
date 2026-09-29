/**
 * What the chat surface may do with an email application.
 *
 * Unlike the tracker commands, one of these really does something outward-facing: approving sends a
 * message to an employer. That is why this port is narrow, why every method takes the id of the
 * chat interaction that carried it, and why approval additionally takes the review reference the
 * person was shown. The command service cannot construct a send out of anything else.
 *
 * Structural on purpose, like `ApplicationCommandPort`: notifications knows what it may ask for and
 * nothing about how it is done.
 */

export type EmailApplicationView = {
  jobId: string;
  jobTitle: string;
  employer: string;
  state: string;
  recipientDomain: string;
  manifestHashPrefix: string;
  /** The provider's acknowledgement, once there is one. */
  providerReference: string | null;
  failureCode: string | null;
  updatedAt: string;
};

export type EmailCommandResult = { ok: boolean; message: string };

export interface EmailApplicationCommandPort {
  /** Reads the advert's application instruction and reports it. Prepares nothing and sends nothing. */
  check(jobIdPrefix: string): Promise<EmailCommandResult>;
  /**
   * Builds the message and posts it for review. The review itself is delivered through the
   * notification outbox, so the reply here only confirms that it is on its way.
   */
  prepare(input: {
    jobIdPrefix: string;
    overrideSalaryFloor: boolean;
    requestId: string;
  }): Promise<EmailCommandResult>;
  /** The only method that can cause an email to be sent. */
  approve(input: {
    jobIdPrefix: string;
    manifestHashPrefix: string;
    requestId: string;
  }): Promise<EmailCommandResult>;
  reject(input: {
    jobIdPrefix: string;
    reason: string | null;
    requestId: string;
  }): Promise<EmailCommandResult>;
  /** Records what the person found after a send the provider never confirmed. */
  reconcile(input: {
    jobIdPrefix: string;
    outcome: 'sent' | 'not_sent';
    providerReference: string | null;
    requestId: string;
  }): Promise<EmailCommandResult>;
  status(jobIdPrefix: string): Promise<EmailCommandResult>;
  list(limit: number): Promise<EmailApplicationView[]>;
}
