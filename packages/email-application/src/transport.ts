import { createHash, randomUUID } from 'node:crypto';

/**
 * The boundary between this agent and an email provider.
 *
 * Three outcomes, and the difference between the last two is the whole point:
 *
 * - `sent` means the provider accepted the message and gave an identifier for it. That identifier is
 *   the receipt, and it is what makes "approve means sent" a statement of fact rather than a hope.
 * - `refused` means the provider is known not to have sent it. The reservation is released and the
 *   person can prepare again.
 * - `uncertain` means nobody knows. A timeout, a dropped connection, or a success with no identifier
 *   all land here. This is never retried automatically, because the one thing worse than not
 *   applying is applying twice; it waits for the person to look in their sent mail and say.
 *
 * A transport must not log, echo or return the body, and must not put an applicant value in an error.
 */

export type EmailAttachment = {
  filename: string;
  contentType: string;
  contentBase64: string;
  sha256: string;
};

export type EmailSendRequest = {
  to: string;
  replyTo: string;
  subject: string;
  body: string;
  attachment: EmailAttachment;
  /**
   * Stable for one approved send. A transport that can deduplicate should; none is required to,
   * because the durable ledger already guarantees at most one attempt per approval.
   */
  idempotencyKey: string;
};

export type EmailSendResult =
  | {
      status: 'sent';
      providerMessageId: string;
      providerThreadId: string | null;
      acceptedAt: string;
    }
  | { status: 'uncertain'; reason: string }
  | { status: 'refused'; errorCode: string };

export interface EmailTransport {
  /** A short, stable name recorded in the review manifest and the receipt. */
  readonly provider: string;
  /** Whether this transport is configured well enough to be used at all. */
  readonly ready: boolean;
  send(request: EmailSendRequest): Promise<EmailSendResult>;
}

const MAX_ATTACHMENT_BASE64 = 8 * 1024 * 1024;

export class AttachmentTooLargeError extends Error {
  constructor() {
    super('The approved CV is too large to attach to an email');
    this.name = 'AttachmentTooLargeError';
  }
}

function encodeHeaderValue(value: string): string {
  // RFC 2047 for anything outside ASCII, so a name with an accent cannot corrupt the headers.
  if (/^[ -~]*$/.test(value)) return value;
  return `=?utf-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

function assertHeaderSafe(name: string, value: string): void {
  if (/[\r\n]/.test(value)) throw new Error(`${name} must not contain a line break`);
}

function wrapBase64(value: string): string {
  return (value.match(/.{1,76}/g) ?? []).join('\r\n');
}

/**
 * An RFC 5322 message with the CV attached. Both parts are base64, so line length, 8-bit characters
 * and trailing whitespace cannot corrupt what the employer receives.
 *
 * `From` is deliberately absent: the provider sets it from the authenticated account, so the agent
 * never asserts an identity of its own.
 */
export function buildMimeMessage(request: EmailSendRequest): string {
  assertHeaderSafe('Recipient', request.to);
  assertHeaderSafe('Reply-To', request.replyTo);
  assertHeaderSafe('Subject', request.subject);
  assertHeaderSafe('Attachment filename', request.attachment.filename);
  if (request.attachment.contentBase64.length > MAX_ATTACHMENT_BASE64) {
    throw new AttachmentTooLargeError();
  }
  if (
    createHash('sha256')
      .update(Buffer.from(request.attachment.contentBase64, 'base64'))
      .digest('hex') !== request.attachment.sha256
  ) {
    throw new Error('Attachment integrity check failed');
  }

  const boundary = `jobagent-${randomUUID()}`;
  return [
    `To: ${encodeHeaderValue(request.to)}`,
    `Reply-To: ${encodeHeaderValue(request.replyTo)}`,
    `Subject: ${encodeHeaderValue(request.subject)}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset="utf-8"',
    'Content-Transfer-Encoding: base64',
    '',
    wrapBase64(Buffer.from(request.body, 'utf8').toString('base64')),
    '',
    `--${boundary}`,
    `Content-Type: ${request.attachment.contentType}; name="${request.attachment.filename}"`,
    'Content-Transfer-Encoding: base64',
    `Content-Disposition: attachment; filename="${request.attachment.filename}"`,
    '',
    wrapBase64(request.attachment.contentBase64),
    '',
    `--${boundary}--`,
    '',
  ].join('\r\n');
}

export type FakeSentMessage = {
  to: string;
  subject: string;
  bodySha256: string;
  attachmentSha256: string;
  idempotencyKey: string;
};

/**
 * A transport that goes nowhere.
 *
 * It exists so the whole path — gates, approval, ledger, receipt, tracker, notification — can be
 * exercised and rehearsed without a provider account, and so the tests prove the outcome handling
 * rather than a provider's behaviour. It records a hash of the body, never the body.
 */
export class FakeEmailTransport implements EmailTransport {
  readonly provider = 'fake';
  readonly ready = true;
  readonly sent: FakeSentMessage[] = [];

  constructor(
    private readonly outcome: (request: EmailSendRequest) => EmailSendResult = () => ({
      status: 'sent',
      providerMessageId: `fake-${randomUUID()}`,
      providerThreadId: null,
      acceptedAt: new Date().toISOString(),
    }),
  ) {}

  send(request: EmailSendRequest): Promise<EmailSendResult> {
    // Built even though nothing is transmitted, so a message that could not be encoded, or whose
    // attachment fails its integrity check, fails here rather than only against a real provider.
    buildMimeMessage(request);
    const result = this.outcome(request);
    if (result.status !== 'refused') {
      this.sent.push({
        to: request.to,
        subject: request.subject,
        bodySha256: createHash('sha256').update(request.body, 'utf8').digest('hex'),
        attachmentSha256: request.attachment.sha256,
        idempotencyKey: request.idempotencyKey,
      });
    }
    return Promise.resolve(result);
  }
}

/** Stands in for a provider that has not been configured. It refuses rather than pretending. */
export class UnconfiguredEmailTransport implements EmailTransport {
  readonly ready = false;

  constructor(readonly provider: string) {}

  send(): Promise<EmailSendResult> {
    return Promise.resolve({ status: 'refused', errorCode: 'transport_not_configured' });
  }
}
