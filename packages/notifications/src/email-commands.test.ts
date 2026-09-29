import { describe, expect, it } from 'vitest';

import type { TrackingStores } from '@job-agent/tracking';

import { DiscordCommandService } from './discord-commands.js';
import type { EmailApplicationCommandPort } from './email-application-port.js';

/**
 * The chat surface of an outward-facing action.
 *
 * `/apply approve` is the one command in this project that can cause something to leave the
 * machine, so these tests are about who may issue it, where, whether it can be issued without
 * having read the message, and what a second copy of the same command does.
 */

const OWNER = 'discord-owner-1';
const OTHER = 'discord-someone-else';
const CHANNEL = 'channel-1';
const JOB = '1a2b3c4d';
const MANIFEST = '9f2c1ab4d0e1';

function inboxOnlyStores(): TrackingStores {
  const seen = new Set<string>();
  return {
    inbox: {
      claim: (channel: string, externalId: string) => {
        const key = `${channel}:${externalId}`;
        if (seen.has(key)) return Promise.resolve(false);
        seen.add(key);
        return Promise.resolve(true);
      },
    },
  } as unknown as TrackingStores;
}

type PortCall = { name: string; input: unknown };

function stubPort(calls: PortCall[]): EmailApplicationCommandPort {
  const record = (name: string, input: unknown, message: string) => {
    calls.push({ name, input });
    return Promise.resolve({ ok: true, message });
  };
  return {
    check: (jobIdPrefix) =>
      record('check', jobIdPrefix, 'The advert asks for applications by email to an address.'),
    prepare: (input) => record('prepare', input, 'A message is ready. Read it before approving.'),
    approve: (input) => record('approve', input, 'Sent. Provider reference gmail-1.'),
    reject: (input) => record('reject', input, 'Rejected. Nothing was sent.'),
    reconcile: (input) => record('reconcile', input, 'Recorded.'),
    status: (jobIdPrefix) => record('status', jobIdPrefix, 'Awaiting your approval.'),
    list: (limit) => {
      calls.push({ name: 'list', input: limit });
      return Promise.resolve([
        {
          jobId: '1a2b3c4d-1111-4111-8111-111111111111',
          jobTitle: 'Community Support Worker',
          employer: 'Exampleshire Council',
          state: 'awaiting_approval',
          recipientDomain: 'exampleshire.gov.uk',
          manifestHashPrefix: MANIFEST,
          providerReference: null,
          failureCode: null,
          updatedAt: '2026-09-29T10:00:00.000Z',
        },
      ]);
    },
  };
}

function interactionBody(input: {
  id: string;
  subCommand: string;
  options?: Record<string, string>;
  userId?: string;
  channelId?: string;
}): string {
  return JSON.stringify({
    id: input.id,
    type: 2,
    channel_id: input.channelId ?? CHANNEL,
    member: { user: { id: input.userId ?? OWNER } },
    data: {
      name: 'apply',
      options: [
        {
          type: 1,
          name: input.subCommand,
          options: Object.entries(input.options ?? {}).map(([name, value]) => ({ name, value })),
        },
      ],
    },
  });
}

function buildService(port?: EmailApplicationCommandPort): DiscordCommandService {
  return new DiscordCommandService({
    stores: inboxOnlyStores(),
    userId: '00000000-0000-4000-8000-000000000000',
    allowedDiscordUserId: OWNER,
    allowedChannelId: CHANNEL,
    ...(port === undefined ? {} : { emailApplications: port }),
  });
}

function replyText(body: Record<string, unknown>): string {
  return (body.data as { content?: string } | undefined)?.content ?? '';
}

describe('who may cause an email to be sent', () => {
  it('refuses a different Discord user, and never reaches the port', async () => {
    const calls: PortCall[] = [];
    const outcome = await buildService(stubPort(calls)).handle({
      rawBody: interactionBody({
        id: 'i-1',
        subCommand: 'approve',
        options: { id: JOB, manifest: MANIFEST },
        userId: OTHER,
      }),
    });
    expect(replyText(outcome.body)).toContain('only takes commands from its owner');
    expect(calls).toHaveLength(0);
  });

  it('refuses a command from another channel, and never reaches the port', async () => {
    const calls: PortCall[] = [];
    const outcome = await buildService(stubPort(calls)).handle({
      rawBody: interactionBody({
        id: 'i-2',
        subCommand: 'approve',
        options: { id: JOB, manifest: MANIFEST },
        channelId: 'somewhere-else',
      }),
    });
    expect(replyText(outcome.body)).toContain('only takes commands in its own channel');
    expect(calls).toHaveLength(0);
  });

  it('does nothing at all when applying by email is not configured', async () => {
    const outcome = await buildService().handle({
      rawBody: interactionBody({
        id: 'i-3',
        subCommand: 'approve',
        options: { id: JOB, manifest: MANIFEST },
      }),
    });
    expect(replyText(outcome.body)).toContain('not configured');
  });
});

describe('approval has to name the message it approves', () => {
  it('refuses an approval with no review reference', async () => {
    const calls: PortCall[] = [];
    const outcome = await buildService(stubPort(calls)).handle({
      rawBody: interactionBody({ id: 'i-4', subCommand: 'approve', options: { id: JOB } }),
    });
    expect(replyText(outcome.body)).toContain('Include the review reference');
    expect(calls).toHaveLength(0);
  });

  it('passes the reference and the interaction id through when it is present', async () => {
    const calls: PortCall[] = [];
    const outcome = await buildService(stubPort(calls)).handle({
      rawBody: interactionBody({
        id: 'i-5',
        subCommand: 'approve',
        options: { id: JOB, manifest: MANIFEST },
      }),
    });
    expect(replyText(outcome.body)).toContain('Sent.');
    expect(calls).toEqual([
      {
        name: 'approve',
        input: { jobIdPrefix: JOB, manifestHashPrefix: MANIFEST, requestId: 'i-5' },
      },
    ]);
  });

  it('refuses a job id too short to identify a vacancy', async () => {
    const calls: PortCall[] = [];
    const outcome = await buildService(stubPort(calls)).handle({
      rawBody: interactionBody({
        id: 'i-6',
        subCommand: 'approve',
        options: { id: 'abc', manifest: MANIFEST },
      }),
    });
    expect(replyText(outcome.body)).toContain('Give me the job id');
    expect(calls).toHaveLength(0);
  });
});

describe('a replayed command', () => {
  it('is dropped before it reaches the port a second time', async () => {
    const calls: PortCall[] = [];
    const service = buildService(stubPort(calls));
    const body = interactionBody({
      id: 'i-replay',
      subCommand: 'approve',
      options: { id: JOB, manifest: MANIFEST },
    });

    const first = await service.handle({ rawBody: body });
    const second = await service.handle({ rawBody: body });

    expect(replyText(first.body)).toContain('Sent.');
    expect(replyText(second.body)).toContain('already handled');
    expect(calls).toHaveLength(1);
  });
});

describe('the rest of the surface', () => {
  it('carries the salary override only when it is asked for', async () => {
    const calls: PortCall[] = [];
    const service = buildService(stubPort(calls));
    await service.handle({
      rawBody: interactionBody({ id: 'i-7', subCommand: 'prepare', options: { id: JOB } }),
    });
    await service.handle({
      rawBody: interactionBody({
        id: 'i-8',
        subCommand: 'prepare',
        options: { id: JOB, override_salary: 'true' },
      }),
    });
    expect(
      calls.map((call) => (call.input as { overrideSalaryFloor: boolean }).overrideSalaryFloor),
    ).toEqual([false, true]);
  });

  it('insists on knowing what the person found before recording an unconfirmed send', async () => {
    const calls: PortCall[] = [];
    const outcome = await buildService(stubPort(calls)).handle({
      rawBody: interactionBody({
        id: 'i-9',
        subCommand: 'reconcile',
        options: { id: JOB, outcome: 'maybe' },
      }),
    });
    expect(replyText(outcome.body)).toContain('outcome:sent or outcome:not_sent');
    expect(calls).toHaveLength(0);
  });

  it('lists prepared applications without putting an address in the list', async () => {
    const calls: PortCall[] = [];
    const outcome = await buildService(stubPort(calls)).handle({
      rawBody: interactionBody({ id: 'i-10', subCommand: 'list' }),
    });
    expect(replyText(outcome.body)).toContain('Community Support Worker');
    expect(replyText(outcome.body)).toContain('awaiting approval');
    expect(replyText(outcome.body)).not.toContain('@');
  });
});
