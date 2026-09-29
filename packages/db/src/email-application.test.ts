import { createHash, randomBytes } from 'node:crypto';

import { defaultAgentConfig } from '@job-agent/config';
import type { KnowledgeFact } from '@job-agent/domain';
import {
  EmailApplicationService,
  FakeEmailTransport,
  type EmailApplicationJobSource,
  type EmailApplicationJobView,
  type EmailApplicationNotifier,
  type EmailApplicationProfileSource,
  type EmailAuditEntry,
  type EmailSendRequest,
  type EmailSendResult,
  type OutcomeNotification,
  type ReviewNotification,
} from '@job-agent/email-application';
import { FieldCipher, StaticEncryptionKeyProvider } from '@job-agent/security';
import { v7 as uuidv7 } from 'uuid';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { PGliteDatabase } from './sql.js';
import { SqlEmailApplicationRepository } from './stores-email-application.js';
import { createMigratedTestDatabase } from './testing.js';

/**
 * The whole email-application path, against the real schema.
 *
 * These are the tests that matter for this milestone, because every control it adds is a control
 * over an outward-facing action: what must be true before a message can be sent, what happens when
 * the world changes between review and approval, and what happens when the provider's answer is
 * anything other than a clear yes.
 */

const cvBytes = Buffer.from('%PDF-1.7 pretend CV');

const ADVERT = [
  'Community Support Worker, Exampleshire Council.',
  'We support adults living at home across the county.',
  'Email your application to recruitment@exampleshire.gov.uk.',
  'Closing date: 30 October 2026.',
].join('\n');

let database: { db: PGliteDatabase; close: () => Promise<void> };
let repository: SqlEmailApplicationRepository;
let cipher: FieldCipher;
let userId: string;
let jobId: string;
let transport: FakeEmailTransport;
let jobs: TestJobSource;
let profile: TestProfileSource;
let notifier: TestNotifier;
let audit: EmailAuditEntry[];
let service: EmailApplicationService;
let sendOutcome: (request: EmailSendRequest) => EmailSendResult;

function fact(
  key: string,
  value: unknown,
  overrides: Partial<KnowledgeFact<unknown>> = {},
): KnowledgeFact<unknown> {
  return {
    id: uuidv7(),
    key,
    value,
    status: 'verified',
    source: 'user',
    sensitivity: 'normal',
    usePolicy: 'auto_fill',
    allowedPurposes: ['matching', 'application'],
    version: 1,
    ...overrides,
  };
}

/** The tracker, as far as this service is concerned. Mutable, so a test can change the world. */
class TestJobSource implements EmailApplicationJobSource {
  view: EmailApplicationJobView;
  applied: Array<{ jobId: string; providerReference: string }> = [];

  constructor(jobIdentifier: string) {
    this.view = {
      jobId: jobIdentifier,
      title: 'Community Support Worker',
      employer: 'Exampleshire Council',
      canonicalUrl: 'https://www.exampleshire.gov.uk/jobs/12345',
      description: ADVERT,
      personSpecificationText: null,
      closesAt: '2026-10-30T23:59:00.000Z',
      jobVersion: 1,
      jobContentHash: 'a'.repeat(64),
      lifecycleStatus: 'open',
      descriptionCompleteness: 'full',
      salaryGate: 'pass',
      hardRejectReasons: [],
      externalSubmissionReference: null,
    };
  }

  load(_userId: string, identifier: string): Promise<EmailApplicationJobView | null> {
    return Promise.resolve(identifier === this.view.jobId ? { ...this.view } : null);
  }

  markApplied(input: { jobId: string; providerReference: string }): Promise<void> {
    this.applied.push({ jobId: input.jobId, providerReference: input.providerReference });
    this.view = { ...this.view, externalSubmissionReference: input.providerReference };
    return Promise.resolve();
  }
}

class TestProfileSource implements EmailApplicationProfileSource {
  facts_: KnowledgeFact<unknown>[] = [
    fact('identity.legal_name', { given: 'Alex', family: 'Morgan' }),
    fact('contact.email', 'alex.morgan@example.test'),
    fact('contact.phone', '07700900123'),
  ];
  cv: { documentId: string; sha256: string; filename: string; contentBase64: string } | null = {
    documentId: uuidv7(),
    sha256: createHash('sha256').update(cvBytes).digest('hex'),
    filename: 'cv.pdf',
    contentBase64: cvBytes.toString('base64'),
  };

  facts(): Promise<readonly KnowledgeFact<unknown>[]> {
    return Promise.resolve(this.facts_);
  }

  approvedDocumentReference(): Promise<{
    documentId: string;
    sha256: string;
    filename: string;
  } | null> {
    if (this.cv === null) return Promise.resolve(null);
    const { documentId, sha256, filename } = this.cv;
    return Promise.resolve({ documentId, sha256, filename });
  }

  approvedUpload(): Promise<typeof this.cv> {
    return Promise.resolve(this.cv);
  }
}

class TestNotifier implements EmailApplicationNotifier {
  reviews: ReviewNotification[] = [];
  sentNotifications: Array<OutcomeNotification & { providerReference: string }> = [];
  uncertainNotifications: OutcomeNotification[] = [];
  failedNotifications: Array<OutcomeNotification & { errorCode: string }> = [];

  reviewReady(notification: ReviewNotification): Promise<void> {
    this.reviews.push(notification);
    return Promise.resolve();
  }

  sent(notification: OutcomeNotification & { providerReference: string }): Promise<void> {
    this.sentNotifications.push(notification);
    return Promise.resolve();
  }

  uncertain(notification: OutcomeNotification): Promise<void> {
    this.uncertainNotifications.push(notification);
    return Promise.resolve();
  }

  failed(notification: OutcomeNotification & { errorCode: string }): Promise<void> {
    this.failedNotifications.push(notification);
    return Promise.resolve();
  }
}

async function seedJob(): Promise<string> {
  const id = uuidv7();
  const companyId = uuidv7();
  await database.db.query(`INSERT INTO companies (id, canonical_name) VALUES ($1, $2)`, [
    companyId,
    `Exampleshire Council ${companyId}`,
  ]);
  await database.db.query(
    `INSERT INTO jobs (
       id, company_id, canonical_url, title, description, location_json, content_hash, fingerprint,
       version, status
     ) VALUES ($1, $2, $3, 'Community Support Worker', $4, '{"text":"Perth"}'::jsonb, $5, $6, 1, 'open')`,
    [
      id,
      companyId,
      `https://www.exampleshire.gov.uk/jobs/${id}`,
      ADVERT,
      createHash('sha256').update(`content:${id}`).digest('hex'),
      createHash('sha256').update(`fingerprint:${id}`).digest('hex'),
    ],
  );
  return id;
}

async function prepareOk(overrides: { overrideSalaryFloor?: boolean } = {}): Promise<string> {
  const result = await service.prepare({
    userId,
    jobId,
    ...(overrides.overrideSalaryFloor === undefined
      ? {}
      : { overrideSalaryFloor: overrides.overrideSalaryFloor }),
  });
  if (result.status !== 'prepared') throw new Error(`expected a review, got ${result.reason}`);
  return result.manifestHash;
}

beforeEach(async () => {
  database = await createMigratedTestDatabase();
  repository = new SqlEmailApplicationRepository(database.db);
  cipher = new FieldCipher(
    new StaticEncryptionKeyProvider('test-v1', new Map([['test-v1', randomBytes(32)]])),
  );
  userId = uuidv7();
  await database.db.query(
    `INSERT INTO users (id, timezone, status) VALUES ($1, 'Europe/London', 'active')`,
    [userId],
  );
  jobId = await seedJob();
  jobs = new TestJobSource(jobId);
  profile = new TestProfileSource();
  notifier = new TestNotifier();
  audit = [];
  sendOutcome = () => ({
    status: 'sent',
    providerMessageId: 'provider-message-1',
    providerThreadId: 'thread-1',
    acceptedAt: '2026-09-29T10:00:00.000Z',
  });
  transport = new FakeEmailTransport((request) => sendOutcome(request));
  service = new EmailApplicationService({
    repository,
    jobs,
    profile,
    transport,
    notifier,
    audit: {
      append: (entry) => {
        audit.push(entry);
        return Promise.resolve();
      },
    },
    cipher,
    config: defaultAgentConfig,
    policyVersion: 'email-application-test',
    now: () => new Date('2026-09-29T10:00:00.000Z'),
  });
});

afterEach(async () => {
  await database.close();
});

describe('preparing a message for review', () => {
  it('produces a review bound to a hash, and sends nothing', async () => {
    const result = await service.prepare({ userId, jobId });
    expect(result.status).toBe('prepared');
    if (result.status !== 'prepared') return;

    expect(result.manifestHash).toHaveLength(64);
    expect(result.reviewChunks.join('\n')).toContain('To: recruitment@exampleshire.gov.uk');
    expect(notifier.reviews).toHaveLength(1);
    expect(transport.sent).toHaveLength(0);
    expect(jobs.applied).toHaveLength(0);
  });

  it('stores the message encrypted, never as readable text', async () => {
    await prepareOk();
    const row = await database.db.query<{ body_ciphertext: unknown; subject: string }>(
      `SELECT body_ciphertext, subject FROM email_applications WHERE user_id = $1`,
      [userId],
    );
    const stored = Buffer.from(row.rows[0]?.body_ciphertext as Uint8Array).toString('utf8');
    expect(stored).not.toContain('Alex Morgan');
    expect(stored).not.toContain('Yours faithfully');
    // The subject carries the vacancy and no personal detail, so it is stored in the clear.
    expect(row.rows[0]?.subject).toBe(
      'Application for Community Support Worker — Exampleshire Council',
    );
  });

  it('refuses an advert that does not ask for an email application', async () => {
    jobs.view = { ...jobs.view, description: 'A lovely job. Closing date: 30 October 2026.' };
    const result = await service.prepare({ userId, jobId });
    expect(result).toMatchObject({ status: 'refused', reason: 'no_email_instruction' });
  });

  it('refuses an advert that asks for an online application as well', async () => {
    jobs.view = {
      ...jobs.view,
      description: `${ADVERT}\nYou can also apply online at our website.`,
    };
    const result = await service.prepare({ userId, jobId });
    expect(result).toMatchObject({ status: 'refused', reason: 'ambiguous_application_route' });
  });

  it('refuses a vacancy restricted to the employer’s own staff', async () => {
    jobs.view = { ...jobs.view, hardRejectReasons: ['restricted_to_internal_candidates'] };
    const result = await service.prepare({ userId, jobId });
    expect(result).toMatchObject({ status: 'refused', reason: 'hard_gate_failed' });
  });

  it('refuses a vacancy that has closed', async () => {
    jobs.view = { ...jobs.view, closesAt: '2026-09-01T00:00:00.000Z' };
    const result = await service.prepare({ userId, jobId });
    expect(result).toMatchObject({ status: 'refused', reason: 'job_closed' });
  });

  it('refuses a lead that was only ever read as an excerpt', async () => {
    jobs.view = { ...jobs.view, descriptionCompleteness: 'snippet' };
    const result = await service.prepare({ userId, jobId });
    expect(result).toMatchObject({ status: 'refused', reason: 'advert_is_excerpt_only' });
  });

  it('refuses a salary below the configured minimum unless it is explicitly overridden', async () => {
    jobs.view = { ...jobs.view, salaryGate: 'reject' };
    expect(await service.prepare({ userId, jobId })).toMatchObject({
      status: 'refused',
      reason: 'salary_below_minimum',
    });

    const overridden = await service.prepare({ userId, jobId, overrideSalaryFloor: true });
    expect(overridden.status).toBe('prepared');
    if (overridden.status !== 'prepared') return;
    expect(overridden.reviewChunks.join('\n')).toContain('overriding the £25,000 minimum');
  });

  it('refuses a salary it could not confirm, for the same reason', async () => {
    jobs.view = { ...jobs.view, salaryGate: 'unknown' };
    expect(await service.prepare({ userId, jobId })).toMatchObject({
      status: 'refused',
      reason: 'salary_not_confirmed',
    });
  });

  it('refuses when no email provider is configured, rather than offering an approval it cannot honour', async () => {
    const unconfigured = new EmailApplicationService({
      repository,
      jobs,
      profile,
      transport: { provider: 'gmail', ready: false, send: () => Promise.reject(new Error('no')) },
      notifier,
      audit: { append: () => Promise.resolve() },
      cipher,
      config: defaultAgentConfig,
      policyVersion: 'email-application-test',
    });
    expect(await unconfigured.prepare({ userId, jobId })).toMatchObject({
      status: 'refused',
      reason: 'transport_not_configured',
    });
  });
});

describe('approval that really does send', () => {
  it('sends once, records the receipt, and marks the vacancy as applied for', async () => {
    const manifestHash = await prepareOk();
    const result = await service.approve({
      userId,
      jobId,
      manifestHashPrefix: manifestHash.slice(0, 12),
      requestId: 'interaction-1',
    });

    expect(result).toMatchObject({ status: 'sent', providerReference: 'provider-message-1' });
    expect(transport.sent).toHaveLength(1);
    expect(transport.sent[0]?.to).toBe('recruitment@exampleshire.gov.uk');

    const status = await service.status(userId, jobId);
    expect(status?.record.state).toBe('sent');
    expect(status?.ledger).toBe('sent');
    expect(status?.receipt).toMatchObject({
      providerMessageId: 'provider-message-1',
      evidenceSource: 'provider_receipt',
    });
    expect(jobs.applied).toEqual([{ jobId, providerReference: 'provider-message-1' }]);
    expect(notifier.sentNotifications).toHaveLength(1);
  });

  it('keeps the address and the message out of the notification it then sends', async () => {
    const manifestHash = await prepareOk();
    await service.approve({ userId, jobId, manifestHashPrefix: manifestHash.slice(0, 12) });
    const notification = JSON.stringify(notifier.sentNotifications);
    expect(notification).toContain('exampleshire.gov.uk');
    expect(notification).not.toContain('recruitment@exampleshire.gov.uk');
    expect(notification).not.toContain('Alex Morgan');
  });

  it('keeps applicant values out of every audit record', async () => {
    const manifestHash = await prepareOk();
    await service.approve({ userId, jobId, manifestHashPrefix: manifestHash.slice(0, 12) });
    const recorded = JSON.stringify(audit);
    expect(recorded).not.toContain('Alex Morgan');
    expect(recorded).not.toContain('alex.morgan@example.test');
    expect(recorded).not.toContain('recruitment@exampleshire.gov.uk');
    expect(recorded).toContain('email_application.sent');
  });

  it('refuses a second approval for a vacancy already sent', async () => {
    const manifestHash = await prepareOk();
    await service.approve({ userId, jobId, manifestHashPrefix: manifestHash.slice(0, 12) });
    const second = await service.approve({
      userId,
      jobId,
      manifestHashPrefix: manifestHash.slice(0, 12),
      requestId: 'interaction-2',
    });
    expect(second).toMatchObject({ status: 'refused', reason: 'already_sent' });
    expect(transport.sent).toHaveLength(1);
  });

  it('will not prepare a vacancy again once it has been applied for', async () => {
    const manifestHash = await prepareOk();
    await service.approve({ userId, jobId, manifestHashPrefix: manifestHash.slice(0, 12) });
    expect(await service.prepare({ userId, jobId })).toMatchObject({
      status: 'refused',
      reason: 'already_sent',
    });
  });
});

describe('a replayed command changes nothing', () => {
  it('sends once when the same approval arrives twice', async () => {
    const manifestHash = await prepareOk();
    const first = await service.approve({
      userId,
      jobId,
      manifestHashPrefix: manifestHash.slice(0, 12),
      requestId: 'interaction-1',
    });
    const replay = await service.approve({
      userId,
      jobId,
      manifestHashPrefix: manifestHash.slice(0, 12),
      requestId: 'interaction-1',
    });

    expect(first.status).toBe('sent');
    expect(replay.status).toBe('replayed');
    expect(transport.sent).toHaveLength(1);
  });

  it('records one rejection when the same rejection arrives twice', async () => {
    await prepareOk();
    expect(
      (await service.reject({ userId, jobId, manifestHashPrefix: '', requestId: 'r-1' })).status,
    ).toBe('rejected');
    expect(
      (await service.reject({ userId, jobId, manifestHashPrefix: '', requestId: 'r-1' })).status,
    ).toBe('replayed');
  });
});

describe('an approval that no longer matches what was shown', () => {
  it('refuses a reference that is not the current review', async () => {
    await prepareOk();
    const result = await service.approve({
      userId,
      jobId,
      manifestHashPrefix: 'deadbeefdead',
    });
    expect(result).toMatchObject({ status: 'refused', reason: 'stale_review' });
    expect(transport.sent).toHaveLength(0);
  });

  it('refuses an approval for a review that preparing again has superseded', async () => {
    const first = await prepareOk();
    profile.facts_ = [
      ...profile.facts_,
      fact('statement.supporting', 'A statement added after the first review.'),
    ];
    const second = await prepareOk();

    expect(second).not.toBe(first);
    expect(
      await service.approve({ userId, jobId, manifestHashPrefix: first.slice(0, 12) }),
    ).toMatchObject({ status: 'refused', reason: 'stale_review' });
    expect(transport.sent).toHaveLength(0);
  });

  it('refuses when the advert changed between review and approval', async () => {
    const manifestHash = await prepareOk();
    jobs.view = { ...jobs.view, jobVersion: 2, jobContentHash: 'e'.repeat(64) };
    expect(
      await service.approve({ userId, jobId, manifestHashPrefix: manifestHash.slice(0, 12) }),
    ).toMatchObject({ status: 'refused', reason: 'advert_changed' });
    expect(transport.sent).toHaveLength(0);
  });

  it('refuses when the advert’s email instruction has been removed', async () => {
    const manifestHash = await prepareOk();
    jobs.view = {
      ...jobs.view,
      description: 'Community Support Worker. Closing date: 30 October 2026.',
    };
    expect(
      await service.approve({ userId, jobId, manifestHashPrefix: manifestHash.slice(0, 12) }),
    ).toMatchObject({ status: 'refused', reason: 'instruction_changed' });
    expect(transport.sent).toHaveLength(0);
  });

  it('refuses when the advert now names a different address', async () => {
    const manifestHash = await prepareOk();
    jobs.view = {
      ...jobs.view,
      description:
        'Email your application to someone-else@exampleshire.gov.uk.\nClosing date: 30 October 2026.',
    };
    expect(
      await service.approve({ userId, jobId, manifestHashPrefix: manifestHash.slice(0, 12) }),
    ).toMatchObject({ status: 'refused', reason: 'instruction_changed' });
    expect(transport.sent).toHaveLength(0);
  });

  it('refuses when the approved CV is no longer the one that was reviewed', async () => {
    const manifestHash = await prepareOk();
    if (profile.cv !== null) profile.cv = { ...profile.cv, sha256: 'f'.repeat(64) };
    expect(
      await service.approve({ userId, jobId, manifestHashPrefix: manifestHash.slice(0, 12) }),
    ).toMatchObject({ status: 'refused', reason: 'cv_changed' });
    expect(transport.sent).toHaveLength(0);
  });

  it('refuses when the stored message does not hash to what was reviewed', async () => {
    const manifestHash = await prepareOk();
    await database.db.query(`UPDATE email_applications SET body_sha256 = $2 WHERE user_id = $1`, [
      userId,
      '0'.repeat(64),
    ]);
    expect(
      await service.approve({ userId, jobId, manifestHashPrefix: manifestHash.slice(0, 12) }),
    ).toMatchObject({ status: 'refused', reason: 'body_changed' });
    expect(transport.sent).toHaveLength(0);
  });

  it('leaves the review approvable after a refusal that happened before the send', async () => {
    const manifestHash = await prepareOk();
    const approvedCv = profile.cv;
    if (approvedCv !== null) profile.cv = { ...approvedCv, sha256: 'f'.repeat(64) };
    expect(
      await service.approve({
        userId,
        jobId,
        manifestHashPrefix: manifestHash.slice(0, 12),
        requestId: 'interaction-1',
      }),
    ).toMatchObject({ status: 'refused', reason: 'cv_changed' });

    // The cause is fixed. The same review must still be approvable: a refused approval that never
    // reached the provider cannot be allowed to strand the message.
    profile.cv = approvedCv;
    const second = await service.approve({
      userId,
      jobId,
      manifestHashPrefix: manifestHash.slice(0, 12),
      requestId: 'interaction-2',
    });
    expect(second.status).toBe('sent');
    expect(transport.sent).toHaveLength(1);
  });

  it('refuses a reference too short to identify a review', async () => {
    await prepareOk();
    expect(await service.approve({ userId, jobId, manifestHashPrefix: 'abc' })).toMatchObject({
      status: 'refused',
      reason: 'manifest_reference_too_short',
    });
  });
});

describe('rejecting', () => {
  it('sends nothing and closes the review', async () => {
    await prepareOk();
    const result = await service.reject({
      userId,
      jobId,
      manifestHashPrefix: '',
      reason: 'not for me',
    });
    expect(result.status).toBe('rejected');
    expect(transport.sent).toHaveLength(0);

    const status = await service.status(userId, jobId);
    expect(status?.record.state).toBe('rejected');
    expect(status?.ledger).toBe('none');
  });

  it('cannot be followed by an approval of the same review', async () => {
    const manifestHash = await prepareOk();
    await service.reject({ userId, jobId, manifestHashPrefix: '' });
    expect(
      await service.approve({ userId, jobId, manifestHashPrefix: manifestHash.slice(0, 12) }),
    ).toMatchObject({ status: 'refused', reason: 'review_not_live' });
    expect(transport.sent).toHaveLength(0);
  });
});

describe('when the provider refuses', () => {
  it('reports that nothing was sent and frees the vacancy to be prepared again', async () => {
    sendOutcome = () => ({ status: 'refused', errorCode: 'not_authorised' });
    const manifestHash = await prepareOk();
    const result = await service.approve({
      userId,
      jobId,
      manifestHashPrefix: manifestHash.slice(0, 12),
    });

    expect(result).toMatchObject({ status: 'failed', errorCode: 'not_authorised' });
    expect(jobs.applied).toHaveLength(0);
    expect(notifier.failedNotifications).toHaveLength(1);

    const status = await service.status(userId, jobId);
    expect(status?.record.state).toBe('failed');
    expect(status?.ledger).toBe('none');
    expect(status?.receipt).toBeNull();

    sendOutcome = () => ({
      status: 'sent',
      providerMessageId: 'provider-message-2',
      providerThreadId: null,
      acceptedAt: '2026-09-29T11:00:00.000Z',
    });
    expect((await service.prepare({ userId, jobId })).status).toBe('prepared');
  });

  it('does not let the consumed approval be used again after a refusal', async () => {
    sendOutcome = () => ({ status: 'refused', errorCode: 'rate_limited' });
    const manifestHash = await prepareOk();
    await service.approve({
      userId,
      jobId,
      manifestHashPrefix: manifestHash.slice(0, 12),
      requestId: 'interaction-1',
    });
    sendOutcome = () => ({
      status: 'sent',
      providerMessageId: 'should-not-happen',
      providerThreadId: null,
      acceptedAt: '2026-09-29T11:00:00.000Z',
    });
    expect(
      await service.approve({
        userId,
        jobId,
        manifestHashPrefix: manifestHash.slice(0, 12),
        requestId: 'interaction-2',
      }),
    ).toMatchObject({ status: 'refused', reason: 'review_not_live' });
    expect(transport.sent).toHaveLength(0);
  });
});

describe('when the provider’s answer is unclear', () => {
  it('pauses for the person instead of retrying', async () => {
    sendOutcome = () => ({ status: 'uncertain', reason: 'no_response_from_provider' });
    const manifestHash = await prepareOk();
    const result = await service.approve({
      userId,
      jobId,
      manifestHashPrefix: manifestHash.slice(0, 12),
    });

    expect(result.status).toBe('uncertain');
    expect(notifier.uncertainNotifications).toHaveLength(1);
    expect(jobs.applied).toHaveLength(0);

    const status = await service.status(userId, jobId);
    expect(status?.record.state).toBe('send_uncertain');
    expect(status?.ledger).toBe('uncertain');
    expect(status?.receipt).toBeNull();
  });

  it('refuses any further approval or preparation until it is reconciled', async () => {
    sendOutcome = () => ({ status: 'uncertain', reason: 'no_response_from_provider' });
    const manifestHash = await prepareOk();
    await service.approve({ userId, jobId, manifestHashPrefix: manifestHash.slice(0, 12) });

    expect(await service.prepare({ userId, jobId })).toMatchObject({
      status: 'refused',
      reason: 'awaiting_reconciliation',
    });
    expect(
      await service.approve({
        userId,
        jobId,
        manifestHashPrefix: manifestHash.slice(0, 12),
        requestId: 'interaction-2',
      }),
    ).toMatchObject({ status: 'refused', reason: 'awaiting_reconciliation' });
  });

  it('records the message as sent when the person finds it in their sent mail', async () => {
    sendOutcome = () => ({ status: 'uncertain', reason: 'provider_http_503' });
    const manifestHash = await prepareOk();
    await service.approve({ userId, jobId, manifestHashPrefix: manifestHash.slice(0, 12) });

    const result = await service.reconcile({
      userId,
      jobId,
      outcome: 'sent',
      providerReference: 'CAB1234@mail.example',
    });
    expect(result.status).toBe('reconciled');

    const status = await service.status(userId, jobId);
    expect(status?.record.state).toBe('sent');
    expect(status?.receipt).toMatchObject({ evidenceSource: 'user_report' });
    expect(jobs.applied).toEqual([{ jobId, providerReference: 'CAB1234@mail.example' }]);
  });

  it('requires evidence rather than a bare assurance', async () => {
    sendOutcome = () => ({ status: 'uncertain', reason: 'provider_http_503' });
    const manifestHash = await prepareOk();
    await service.approve({ userId, jobId, manifestHashPrefix: manifestHash.slice(0, 12) });
    expect(
      await service.reconcile({ userId, jobId, outcome: 'sent', providerReference: '  ' }),
    ).toMatchObject({ status: 'refused', reason: 'reference_required' });
  });

  it('frees the vacancy again when the person confirms nothing went', async () => {
    sendOutcome = () => ({ status: 'uncertain', reason: 'provider_http_503' });
    const manifestHash = await prepareOk();
    await service.approve({ userId, jobId, manifestHashPrefix: manifestHash.slice(0, 12) });

    expect((await service.reconcile({ userId, jobId, outcome: 'not_sent' })).status).toBe(
      'reconciled',
    );
    expect(jobs.applied).toHaveLength(0);
    sendOutcome = () => ({
      status: 'sent',
      providerMessageId: 'provider-message-3',
      providerThreadId: null,
      acceptedAt: '2026-09-29T12:00:00.000Z',
    });
    expect((await service.prepare({ userId, jobId })).status).toBe('prepared');
  });
});

describe('the daily cap', () => {
  it('stops a send once the day’s slots are used', async () => {
    // Fill the day with other vacancies' ledger rows, which is what the cap actually counts.
    for (let index = 0; index < defaultAgentConfig.submission.maxAutoPerLocalDay; index += 1) {
      await database.db.query(
        `INSERT INTO email_applications (
           id, user_id, job_id, state, recipient, recipient_domain, subject, body_ciphertext,
           body_sha256, body_characters, manifest_hash, manifest_json, instruction_json,
           job_version, job_content_hash, salary_gate
         ) VALUES ($1,$2,$3,'sent','a@b.example','b.example','s',$4,$5,1,$6,'{}'::jsonb,'{}'::jsonb,
           1,$7,'pass')`,
        [
          uuidv7(),
          userId,
          await seedJob(),
          Buffer.from('x'),
          '1'.repeat(64),
          index.toString().padStart(64, '0'),
          'c'.repeat(64),
        ],
      );
      const filler = await database.db.query<{ id: string }>(
        `SELECT id FROM email_applications WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`,
        [userId],
      );
      const approvalId = uuidv7();
      await database.db.query(
        `INSERT INTO email_application_approvals (
           id, email_application_id, manifest_hash, decision, approver_channel, correlation_id,
           expires_at
         ) VALUES ($1,$2,$3,'approved','local',$4, now() + interval '1 day')`,
        [approvalId, filler.rows[0]?.id, '2'.repeat(64), uuidv7()],
      );
      await database.db.query(
        `INSERT INTO email_send_ledger (
           id, user_id, email_application_id, approval_id, local_date, status, idempotency_key
         ) VALUES ($1,$2,$3,$4,'2026-09-29','sent',$5)`,
        [uuidv7(), userId, filler.rows[0]?.id, approvalId, uuidv7()],
      );
    }

    const manifestHash = await prepareOk();
    const result = await service.approve({
      userId,
      jobId,
      manifestHashPrefix: manifestHash.slice(0, 12),
      requestId: 'interaction-1',
    });
    expect(result).toMatchObject({ status: 'refused', reason: 'daily_cap_reached' });
    expect(transport.sent).toHaveLength(0);

    // Once the day has room again the same review must still be approvable. Hitting the cap is a
    // "not now", not a reason to throw away a message the person has already read and approved.
    await database.db.query(
      `DELETE FROM email_send_ledger WHERE id IN (SELECT id FROM email_send_ledger LIMIT 1)`,
    );
    const second = await service.approve({
      userId,
      jobId,
      manifestHashPrefix: manifestHash.slice(0, 12),
      requestId: 'interaction-2',
    });
    expect(second.status).toBe('sent');
    expect(transport.sent).toHaveLength(1);
  });
});

describe('rebuilding a review for delivery', () => {
  it('returns the same text the person was shown', async () => {
    const result = await service.prepare({ userId, jobId });
    if (result.status !== 'prepared') throw new Error('expected a review');
    const chunks = await service.reviewChunks(result.record.id, result.manifestHash);
    expect(chunks).toEqual(result.reviewChunks);
  });

  it('returns nothing once the review has been superseded', async () => {
    const result = await service.prepare({ userId, jobId });
    if (result.status !== 'prepared') throw new Error('expected a review');
    profile.facts_ = [...profile.facts_, fact('statement.supporting', 'Added afterwards.')];
    await prepareOk();
    expect(await service.reviewChunks(result.record.id, result.manifestHash)).toBeNull();
  });
});
