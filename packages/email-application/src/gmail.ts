import { redact, silentLogger, type StructuredLogger } from '@job-agent/observability';

import {
  buildMimeMessage,
  type EmailSendRequest,
  type EmailSendResult,
  type EmailTransport,
} from './transport.js';

/**
 * Sending through the applicant's own Gmail account, using Google's documented API.
 *
 * Why this one. It is a published API with a scope that does exactly one thing —
 * `https://www.googleapis.com/auth/gmail.send` permits sending and grants no read access at all, so
 * the credential cannot be turned into a way to read anyone's mail. The account is the applicant's
 * own and they authorise it themselves; the message lands in their own Sent folder, where they can
 * see and quote it; and the API returns a message id, which is a real receipt rather than an
 * assumption. Nothing here reads, lists, labels or deletes anything.
 *
 * What it deliberately does not do: refresh anything but an access token, fall back to SMTP, or
 * retry. A send whose outcome is unclear is reported as unclear.
 */

export type GmailTransportOptions = {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  fetcher?: typeof fetch;
  logger?: StructuredLogger;
  tokenEndpoint?: string;
  sendEndpoint?: string;
  timeoutMs?: number;
  now?: () => Date;
};

const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const SEND_ENDPOINT = 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send';

function base64Url(value: string): string {
  return Buffer.from(value, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

export class GmailEmailTransport implements EmailTransport {
  readonly provider = 'gmail';
  private readonly logger: StructuredLogger;
  private accessToken: { value: string; expiresAt: number } | null = null;

  constructor(private readonly options: GmailTransportOptions) {
    this.logger = options.logger ?? silentLogger;
  }

  get ready(): boolean {
    return (
      this.options.clientId !== '' &&
      this.options.clientSecret !== '' &&
      this.options.refreshToken !== ''
    );
  }

  private now(): number {
    return (this.options.now?.() ?? new Date()).getTime();
  }

  /**
   * Exchanges the stored refresh token for a short-lived access token.
   *
   * Throws a bare code on failure. The client secret and both tokens are only ever request fields:
   * they are never returned, logged or included in an error.
   */
  private async authorise(): Promise<string> {
    const cached = this.accessToken;
    if (cached !== null && cached.expiresAt > this.now() + 60_000) return cached.value;

    const fetcher = this.options.fetcher ?? fetch;
    const response = await fetcher(this.options.tokenEndpoint ?? TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: this.options.clientId,
        client_secret: this.options.clientSecret,
        refresh_token: this.options.refreshToken,
        grant_type: 'refresh_token',
      }).toString(),
      signal: AbortSignal.timeout(this.options.timeoutMs ?? 20_000),
    });
    if (!response.ok) throw new Error(`token_http_${String(response.status)}`);
    const payload = (await response.json()) as { access_token?: unknown; expires_in?: unknown };
    if (typeof payload.access_token !== 'string' || payload.access_token === '') {
      throw new Error('token_missing');
    }
    const lifetime = typeof payload.expires_in === 'number' ? payload.expires_in : 300;
    this.accessToken = {
      value: payload.access_token,
      expiresAt: this.now() + lifetime * 1000,
    };
    return payload.access_token;
  }

  async send(request: EmailSendRequest): Promise<EmailSendResult> {
    if (!this.ready) return { status: 'refused', errorCode: 'transport_not_configured' };

    let raw: string;
    try {
      raw = base64Url(buildMimeMessage(request));
    } catch (error) {
      // Encoding failures are the agent's fault, not the provider's, and nothing was transmitted.
      this.logger.log('error', 'Email could not be encoded', {
        errorMessage: redact(error instanceof Error ? error.message : 'unknown'),
      });
      return { status: 'refused', errorCode: 'message_not_encodable' };
    }

    let token: string;
    try {
      token = await this.authorise();
    } catch (error) {
      // Authorisation happens before anything is submitted, so this is definitely a non-send.
      this.logger.log('error', 'Email provider authorisation failed', {
        errorCode: error instanceof Error ? error.message : 'unknown',
      });
      return { status: 'refused', errorCode: 'not_authorised' };
    }

    const fetcher = this.options.fetcher ?? fetch;
    let response: Response;
    try {
      response = await fetcher(this.options.sendEndpoint ?? SEND_ENDPOINT, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ raw }),
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 20_000),
      });
    } catch {
      // The request left this process and no answer came back. It may or may not have been sent.
      return { status: 'uncertain', reason: 'no_response_from_provider' };
    }

    if (response.status === 401 || response.status === 403) {
      return { status: 'refused', errorCode: 'not_authorised' };
    }
    if (response.status === 429) return { status: 'refused', errorCode: 'rate_limited' };
    if (response.status >= 500) {
      // A 5xx may follow a message the provider already queued. Never assume, and never retry.
      return { status: 'uncertain', reason: `provider_http_${String(response.status)}` };
    }
    if (!response.ok) {
      return { status: 'refused', errorCode: `provider_http_${String(response.status)}` };
    }

    let payload: { id?: unknown; threadId?: unknown };
    try {
      payload = (await response.json()) as { id?: unknown; threadId?: unknown };
    } catch {
      return { status: 'uncertain', reason: 'accepted_without_readable_receipt' };
    }
    if (typeof payload.id !== 'string' || payload.id === '') {
      return { status: 'uncertain', reason: 'accepted_without_message_id' };
    }
    return {
      status: 'sent',
      providerMessageId: payload.id,
      providerThreadId: typeof payload.threadId === 'string' ? payload.threadId : null,
      acceptedAt: new Date(this.now()).toISOString(),
    };
  }
}
