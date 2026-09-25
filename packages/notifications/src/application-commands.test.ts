import { describe, expect, it } from 'vitest';

import type { TrackingStores } from '@job-agent/tracking';

import type {
  ApplicationCommandPort,
  ApplicationSummaryView,
  PausedQuestionView,
} from './application-port.js';
import { DiscordCommandService } from './discord-commands.js';

const OWNER = 'discord-owner-1';
const CHANNEL = 'channel-1';
const APPLICATION_ID = '1a2b3c4d-1111-4111-8111-111111111111';
const MANIFEST = '9f2c1ab4d0e1aa77';

/** Only the part of the tracking stores the command surface touches. */
function inboxOnlyStores(): { stores: TrackingStores; claims: string[] } {
  const seen = new Map<string, string>();
  const claims: string[] = [];
  const stores = {
    inbox: {
      claim: (channel: string, externalId: string, payloadHash: string) => {
        claims.push(externalId);
        const key = `${channel}:${externalId}`;
        if (seen.has(key)) return Promise.resolve(false);
        seen.set(key, payloadHash);
        return Promise.resolve(true);
      },
    },
  } as unknown as TrackingStores;
  return { stores, claims };
}

type PortCall = { name: string; input: unknown };

function stubPort(calls: PortCall[]): ApplicationCommandPort {
  const summary: ApplicationSummaryView = {
    applicationId: APPLICATION_ID,
    jobTitle: 'Records Officer',
    employer: 'Fake ATS Council',
    stage: 'WAITING_USER',
    attemptStatus: 'paused',
    pauseReason: 'unknown_field',
    openQuestions: 1,
    manifestHashPrefix: MANIFEST.slice(0, 12),
    approvalState: 'none',
    confirmationReference: null,
    takeoverRequested: false,
  };
  const question: PausedQuestionView = {
    questionId: '2b2b2b2b-2222-4222-8222-222222222222',
    applicationId: APPLICATION_ID,
    prompt: 'The form asks for your favourite colour and I have no verified fact for it.',
    reason: 'unknown_field',
    responseKind: 'text',
    allowedValues: [],
  };
  return {
    list: (limit) => {
      calls.push({ name: 'list', input: limit });
      return Promise.resolve([summary]);
    },
    show: (idPrefix) => {
      calls.push({ name: 'show', input: idPrefix });
      return Promise.resolve(summary);
    },
    currentQuestion: (idPrefix) => {
      calls.push({ name: 'currentQuestion', input: idPrefix });
      return Promise.resolve(question);
    },
    answer: (input) => {
      calls.push({ name: 'answer', input });
      return Promise.resolve({ ok: true, message: 'Saved for this application only.' });
    },
    decide: (input) => {
      calls.push({ name: 'decide', input });
      return Promise.resolve({
        ok: true,
        message: 'Approved. The practice submission can run once.',
      });
    },
    requestTakeover: (idPrefix) => {
      calls.push({ name: 'requestTakeover', input: idPrefix });
      return Promise.resolve({ ok: true, message: 'The agent has stopped. The browser is yours.' });
    },
    resume: (idPrefix) => {
      calls.push({ name: 'resume', input: idPrefix });
      return Promise.resolve({ ok: true, message: 'Resumed.' });
    },
  };
}

function interactionBody(input: {
  id: string;
  subCommand: string;
  options?: Record<string, string>;
  userId?: string;
}): string {
  return JSON.stringify({
    id: input.id,
    type: 2,
    channel_id: CHANNEL,
    member: { user: { id: input.userId ?? OWNER } },
    data: {
      name: 'application',
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

function buildService(port?: ApplicationCommandPort): {
  service: DiscordCommandService;
  claims: string[];
} {
  const { stores, claims } = inboxOnlyStores();
  const service = new DiscordCommandService({
    stores,
    userId: '00000000-0000-4000-8000-000000000000',
    allowedDiscordUserId: OWNER,
    allowedChannelId: CHANNEL,
    ...(port === undefined ? {} : { applications: port }),
  });
  return { service, claims };
}

function replyText(body: Record<string, unknown>): string {
  const data = body.data as { content?: string } | undefined;
  return data?.content ?? '';
}

describe('Discord application commands', () => {
  it('lists practice applications and says no employer is involved', async () => {
    const calls: PortCall[] = [];
    const { service } = buildService(stubPort(calls));
    const outcome = await service.handle({
      rawBody: interactionBody({ id: 'i-list', subCommand: 'list' }),
    });
    expect(outcome.httpStatus).toBe(200);
    expect(replyText(outcome.body)).toContain('local fake ATS');
    expect(replyText(outcome.body)).toContain('Records Officer');
    expect(calls).toHaveLength(1);
  });

  it('shows the paused question and how to answer it', async () => {
    const calls: PortCall[] = [];
    const { service } = buildService(stubPort(calls));
    const outcome = await service.handle({
      rawBody: interactionBody({
        id: 'i-question',
        subCommand: 'question',
        options: { id: '1a2b3c4d' },
      }),
    });
    const text = replyText(outcome.body);
    expect(text).toContain('favourite colour');
    expect(text).toContain('/application answer');
    expect(calls[0]?.name).toBe('currentQuestion');
  });

  it('answers once and treats an identical replayed interaction as already handled', async () => {
    const calls: PortCall[] = [];
    const { service } = buildService(stubPort(calls));
    const body = interactionBody({
      id: 'i-answer',
      subCommand: 'answer',
      options: { id: '1a2b3c4d', value: 'Blue' },
    });

    const first = await service.handle({ rawBody: body });
    expect(replyText(first.body)).toContain('Saved for this application only.');

    const replay = await service.handle({ rawBody: body });
    expect(replay.httpStatus).toBe(200);
    expect(replyText(replay.body)).toContain('already handled');

    // The port saw the answer exactly once, so a replay cannot write a second answer.
    expect(calls.filter((call) => call.name === 'answer')).toHaveLength(1);
  });

  it('passes the interaction id through so the answer itself is idempotent downstream', async () => {
    const calls: PortCall[] = [];
    const { service } = buildService(stubPort(calls));
    await service.handle({
      rawBody: interactionBody({
        id: 'i-answer-2',
        subCommand: 'answer',
        options: { id: '1a2b3c4d', value: 'Blue' },
      }),
    });
    expect(calls[0]?.input).toMatchObject({ interactionId: 'i-answer-2', saveToProfile: false });
  });

  it('approves only with a review manifest reference and replays harmlessly', async () => {
    const calls: PortCall[] = [];
    const { service } = buildService(stubPort(calls));

    const withoutManifest = await service.handle({
      rawBody: interactionBody({
        id: 'i-approve-bad',
        subCommand: 'approve',
        options: { id: '1a2b3c4d' },
      }),
    });
    expect(replyText(withoutManifest.body)).toContain('review manifest reference');
    expect(calls).toHaveLength(0);

    const body = interactionBody({
      id: 'i-approve',
      subCommand: 'approve',
      options: { id: '1a2b3c4d', manifest: MANIFEST.slice(0, 12) },
    });
    await service.handle({ rawBody: body });
    await service.handle({ rawBody: body });
    expect(calls.filter((call) => call.name === 'decide')).toHaveLength(1);
    expect(calls[0]?.input).toMatchObject({ decision: 'approved', interactionId: 'i-approve' });
  });

  it('records takeover and resume requests', async () => {
    const calls: PortCall[] = [];
    const { service } = buildService(stubPort(calls));
    const takeover = await service.handle({
      rawBody: interactionBody({
        id: 'i-takeover',
        subCommand: 'takeover',
        options: { id: '1a2b3c4d' },
      }),
    });
    expect(replyText(takeover.body)).toContain('browser is yours');
    const resumed = await service.handle({
      rawBody: interactionBody({
        id: 'i-resume',
        subCommand: 'resume',
        options: { id: '1a2b3c4d' },
      }),
    });
    expect(replyText(resumed.body)).toContain('Resumed');
    expect(calls.map((call) => call.name)).toEqual(['requestTakeover', 'resume']);
  });

  it('refuses a different Discord user before touching the application at all', async () => {
    const calls: PortCall[] = [];
    const { service, claims } = buildService(stubPort(calls));
    const outcome = await service.handle({
      rawBody: interactionBody({
        id: 'i-intruder',
        subCommand: 'approve',
        options: { id: '1a2b3c4d', manifest: MANIFEST.slice(0, 12) },
        userId: 'someone-else',
      }),
    });
    expect(replyText(outcome.body)).toContain('only takes commands from its owner');
    expect(calls).toHaveLength(0);
    expect(claims).toHaveLength(0);
  });

  it('says application commands are unavailable when the browser runtime is not wired in', async () => {
    const { service } = buildService();
    const outcome = await service.handle({
      rawBody: interactionBody({ id: 'i-none', subCommand: 'list' }),
    });
    expect(replyText(outcome.body)).toContain('not available in this build');
  });
});
