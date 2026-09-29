import { generateKeyPairSync, sign as signMessage } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { buildCard, renderCardText, safePayload } from './cards.js';
import { parseInteraction, verifyInteractionSignature } from './discord-interactions.js';

const keyPair = generateKeyPairSync('ed25519');
const publicKeyHex = keyPair.publicKey
  .export({ format: 'der', type: 'spki' })
  .subarray(12)
  .toString('hex');

function signedRequest(body: string, timestampSeconds: number): string {
  return signMessage(
    null,
    Buffer.from(String(timestampSeconds) + body, 'utf8'),
    keyPair.privateKey,
  ).toString('hex');
}

describe('notification cards', () => {
  it('describes a match in plain language and says nothing was applied for', () => {
    const card = buildCard({
      eventType: 'JOB_MATCHED',
      payload: {
        title: 'Information Governance Officer',
        employer: 'Example Council',
        location: 'Glasgow',
        score: 78,
        salaryGate: 'unknown',
        salaryText: 'Negotiable',
        unknownRequirements: 2,
        blockers: ['salary_unknown'],
        url: 'https://myjobscotland.gov.uk/jobs/1',
      },
    });
    const text = renderCardText(card);
    expect(text).toContain('Information Governance Officer');
    expect(text).toContain('78/100');
    expect(text).toContain('not certain');
    expect(text).toContain('This is a shortlist notice only.');
  });

  it('drops anything that is not on the notification allow list', () => {
    const payload = safePayload({
      title: 'Officer',
      applicantName: 'Samuel',
      cvText: 'Six years in FCA regulated firms',
      homeAddress: '95 Example Street',
      botToken: 'secret-token-value',
      score: 70,
    });
    expect(payload).toEqual({ title: 'Officer', score: 70 });
    expect(JSON.stringify(payload)).not.toContain('Samuel');
  });

  it('announces leads without claiming any of them is a match', () => {
    const text = renderCardText(
      buildCard({
        eventType: 'LEADS_DISCOVERED',
        payload: {
          source: 'Adzuna UK job search (documented API)',
          sourceKey: 'adzuna_gb_search',
          newLeads: 5,
          criteriaRead: 0,
          examples: ['Fraud Specialist — Teleperformance', 'Compliance Analyst — Adecco'],
        },
      }),
    );
    expect(text).toContain('5 new vacancies');
    expect(text).toContain('Fraud Specialist');
    expect(text).toContain('requirements have not been read');
    expect(text).toContain('leads to look at, not matches');
    expect(text).toContain('Nothing has been applied for.');
    // The wording a match card uses must never appear here.
    expect(text).not.toContain('/100');
    expect(text).not.toContain('shortlist');
  });

  it('omits the unread-criteria warning when every lead had its criteria read', () => {
    const text = renderCardText(
      buildCard({
        eventType: 'LEADS_DISCOVERED',
        payload: { source: 'A reviewed source', newLeads: 2, criteriaRead: 2, examples: [] },
      }),
    );
    expect(text).toContain('2 new vacancies');
    expect(text).not.toContain('have not been read');
  });

  it('keeps applicant data out of a leads notification', () => {
    const payload = safePayload({
      newLeads: 3,
      criteriaRead: 0,
      examples: ['Fraud Specialist — Teleperformance'],
      applicantName: 'Samuel',
      cvText: 'Six years in FCA regulated firms',
    });
    expect(payload).toEqual({
      newLeads: 3,
      criteriaRead: 0,
      examples: ['Fraud Specialist — Teleperformance'],
    });
    expect(JSON.stringify(payload)).not.toContain('Samuel');
  });

  it('explains a discovery failure without leaking the cause detail', () => {
    const text = renderCardText(
      buildCard({
        eventType: 'DISCOVERY_FAILED',
        payload: { source: 'MyJobScotland links', errorCode: 'TypeError', circuitOpened: true },
      }),
    );
    expect(text).toContain('paused for an hour');
    expect(text).toContain('No applications or messages were sent.');
  });
});

describe('Discord interaction verification', () => {
  const body = JSON.stringify({ type: 1 });

  it('accepts a correctly signed, fresh request', () => {
    const now = new Date('2026-09-25T10:00:00.000Z');
    const timestamp = Math.floor(now.getTime() / 1000);
    expect(
      verifyInteractionSignature({
        publicKeyHex,
        signatureHex: signedRequest(body, timestamp),
        timestamp: String(timestamp),
        rawBody: body,
        now,
      }),
    ).toEqual({ valid: true });
  });

  it('rejects a tampered body', () => {
    const now = new Date('2026-09-25T10:00:00.000Z');
    const timestamp = Math.floor(now.getTime() / 1000);
    expect(
      verifyInteractionSignature({
        publicKeyHex,
        signatureHex: signedRequest(body, timestamp),
        timestamp: String(timestamp),
        rawBody: JSON.stringify({ type: 2 }),
        now,
      }),
    ).toEqual({ valid: false, reason: 'bad_signature' });
  });

  it('rejects a replayed request from outside the time window', () => {
    const signedAt = Math.floor(new Date('2026-09-25T10:00:00.000Z').getTime() / 1000);
    expect(
      verifyInteractionSignature({
        publicKeyHex,
        signatureHex: signedRequest(body, signedAt),
        timestamp: String(signedAt),
        rawBody: body,
        now: new Date('2026-09-25T11:00:00.000Z'),
      }).valid,
    ).toBe(false);
  });

  it('rejects a request with no signature headers', () => {
    expect(
      verifyInteractionSignature({
        publicKeyHex,
        signatureHex: undefined,
        timestamp: undefined,
        rawBody: body,
      }),
    ).toEqual({ valid: false, reason: 'missing_headers' });
  });
});

describe('interaction parsing', () => {
  it('reads the user, channel and sub-command options', () => {
    const parsed = parseInteraction({
      id: '1',
      type: 2,
      channel_id: 'channel-1',
      member: { user: { id: 'user-1' } },
      data: {
        name: 'job',
        options: [{ type: 1, name: 'show', options: [{ name: 'id', value: 'abcdef12' }] }],
      },
    });
    expect(parsed).toMatchObject({
      userId: 'user-1',
      channelId: 'channel-1',
      commandName: 'job',
      subCommand: 'show',
      options: { id: 'abcdef12' },
    });
  });
});
