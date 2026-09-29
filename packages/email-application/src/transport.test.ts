import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { GmailEmailTransport } from './gmail.js';
import {
  AttachmentTooLargeError,
  buildMimeMessage,
  FakeEmailTransport,
  UnconfiguredEmailTransport,
  type EmailSendRequest,
} from './transport.js';

const cvBytes = Buffer.from('%PDF-1.7 a small pretend CV');
const attachment = {
  filename: 'cv.pdf',
  contentType: 'application/pdf',
  contentBase64: cvBytes.toString('base64'),
  sha256: createHash('sha256').update(cvBytes).digest('hex'),
};

function request(overrides: Partial<EmailSendRequest> = {}): EmailSendRequest {
  return {
    to: 'recruitment@exampleshire.gov.uk',
    replyTo: 'alex.morgan@example.test',
    subject: 'Application for Community Support Worker — Exampleshire Council',
    body: 'Dear Sir or Madam,\n\nI would like to apply.\n\nYours faithfully,\nAlex Morgan\n',
    attachment,
    idempotencyKey: 'application-1:hash-1',
    ...overrides,
  };
}

describe('the message that would leave the machine', () => {
  it('carries the recipient, reply address, subject and the CV', () => {
    const mime = buildMimeMessage(request());
    expect(mime).toContain('To: recruitment@exampleshire.gov.uk');
    expect(mime).toContain('Reply-To: alex.morgan@example.test');
    expect(mime).toContain('Content-Disposition: attachment; filename="cv.pdf"');
    // The base64 parts are wrapped at 76 columns, so the comparison is made without line breaks.
    expect(mime.replace(/\r\n/g, '')).toContain(
      Buffer.from(request().body, 'utf8').toString('base64'),
    );
  });

  it('asserts no identity of its own, leaving From to the authenticated account', () => {
    expect(buildMimeMessage(request())).not.toMatch(/^From:/m);
  });

  it('encodes a subject that is not plain ASCII rather than emitting raw bytes', () => {
    const mime = buildMimeMessage(request({ subject: 'Application — Café Assistant' }));
    expect(mime).toContain('Subject: =?utf-8?B?');
    expect(mime).not.toContain('Subject: Application — Café Assistant');
  });

  it('refuses a header carrying a line break, so nothing can be injected into the envelope', () => {
    expect(() =>
      buildMimeMessage(request({ subject: 'Application\r\nBcc: someone@elsewhere.example' })),
    ).toThrow(/line break/);
  });

  it('refuses an attachment whose bytes do not match the hash that was approved', () => {
    expect(() =>
      buildMimeMessage(request({ attachment: { ...attachment, sha256: 'a'.repeat(64) } })),
    ).toThrow(/integrity/);
  });

  it('refuses an attachment too large to send', () => {
    expect(() =>
      buildMimeMessage(
        request({
          attachment: { ...attachment, contentBase64: 'A'.repeat(9 * 1024 * 1024) },
        }),
      ),
    ).toThrow(AttachmentTooLargeError);
  });
});

describe('the transport used for rehearsal', () => {
  it('records that a message was sent without keeping its text', () => {
    const transport = new FakeEmailTransport();
    void transport.send(request());
    const [sent] = transport.sent;
    if (sent === undefined) throw new Error('expected a recorded send');
    expect(sent.to).toBe('recruitment@exampleshire.gov.uk');
    expect(sent.bodySha256).toHaveLength(64);
    expect(JSON.stringify(sent)).not.toContain('Yours faithfully');
  });

  it('reports itself unusable when no provider is configured', async () => {
    const transport = new UnconfiguredEmailTransport('gmail');
    expect(transport.ready).toBe(false);
    expect(await transport.send()).toEqual({
      status: 'refused',
      errorCode: 'transport_not_configured',
    });
  });
});

function gmail(respond: (href: string) => Response): GmailEmailTransport {
  return new GmailEmailTransport({
    clientId: 'client',
    clientSecret: 'secret',
    refreshToken: 'refresh',
    // A stub that answers by URL. Throwing from it stands for a connection that never answered.
    fetcher: (url) => Promise.resolve(respond(url instanceof Request ? url.url : url.toString())),
    now: () => new Date('2026-09-29T10:00:00.000Z'),
  });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('sending through the applicant’s own Gmail account', () => {
  it('is not ready until every credential is present', () => {
    expect(
      new GmailEmailTransport({ clientId: '', clientSecret: '', refreshToken: '' }).ready,
    ).toBe(false);
  });

  it('exchanges the refresh token and returns the provider’s message id as the receipt', async () => {
    const calls: string[] = [];
    const transport = gmail((href) => {
      calls.push(href);
      if (href.includes('oauth2')) return jsonResponse({ access_token: 'at', expires_in: 3600 });
      return jsonResponse({ id: 'gmail-message-1', threadId: 'thread-1' });
    });

    const result = await transport.send(request());
    expect(result).toMatchObject({
      status: 'sent',
      providerMessageId: 'gmail-message-1',
      providerThreadId: 'thread-1',
    });
    expect(calls[1]).toContain('gmail/v1/users/me/messages/send');
  });

  it('treats a rejected credential as a definite non-send', async () => {
    const transport = gmail((href) => {
      if (href.includes('oauth2')) return jsonResponse({ access_token: 'at', expires_in: 3600 });
      return new Response('{}', { status: 403 });
    });
    expect(await transport.send(request())).toEqual({
      status: 'refused',
      errorCode: 'not_authorised',
    });
  });

  it('treats a provider error as uncertain, because it may have queued the message', async () => {
    const transport = gmail((href) => {
      if (href.includes('oauth2')) return jsonResponse({ access_token: 'at', expires_in: 3600 });
      return new Response('{}', { status: 503 });
    });
    expect(await transport.send(request())).toEqual({
      status: 'uncertain',
      reason: 'provider_http_503',
    });
  });

  it('treats a dropped connection as uncertain rather than as a failure', async () => {
    const transport = gmail((href) => {
      if (href.includes('oauth2')) return jsonResponse({ access_token: 'at', expires_in: 3600 });
      throw new Error('socket hang up');
    });
    expect(await transport.send(request())).toEqual({
      status: 'uncertain',
      reason: 'no_response_from_provider',
    });
  });

  it('treats an acceptance with no message id as uncertain, since there is no receipt', async () => {
    const transport = gmail((href) => {
      if (href.includes('oauth2')) return jsonResponse({ access_token: 'at', expires_in: 3600 });
      return jsonResponse({ ok: true });
    });
    expect(await transport.send(request())).toEqual({
      status: 'uncertain',
      reason: 'accepted_without_message_id',
    });
  });

  it('does not attempt a send when authorisation fails, and says nothing was sent', async () => {
    let sendAttempts = 0;
    const transport = gmail((href) => {
      if (href.includes('oauth2')) return new Response('{}', { status: 400 });
      sendAttempts += 1;
      return jsonResponse({ id: 'should-not-happen' });
    });
    expect(await transport.send(request())).toEqual({
      status: 'refused',
      errorCode: 'not_authorised',
    });
    expect(sendAttempts).toBe(0);
  });

  it('never puts a credential in a result', async () => {
    const transport = gmail((href) => {
      if (href.includes('oauth2'))
        return jsonResponse({ access_token: 'at-secret', expires_in: 1 });
      return new Response('{}', { status: 400 });
    });
    const result = JSON.stringify(await transport.send(request()));
    expect(result).not.toContain('at-secret');
    expect(result).not.toContain('refresh');
    expect(result).not.toContain('secret');
  });
});
