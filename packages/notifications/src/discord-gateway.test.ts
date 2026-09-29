import { describe, expect, it, vi } from 'vitest';

import type { DiscordCommandService } from './discord-commands.js';
import { DiscordGateway } from './discord-gateway.js';

class FakeSocket {
  readyState = 1;
  sent: string[] = [];
  private listeners = new Map<string, ((event: { data?: unknown; code?: number }) => void)[]>();

  addEventListener(
    name: string,
    listener: (event: { data?: unknown; code?: number }) => void,
  ): void {
    this.listeners.set(name, [...(this.listeners.get(name) ?? []), listener]);
  }

  send(value: string): void {
    this.sent.push(value);
  }

  close(code = 1000): void {
    this.readyState = 3;
    for (const listener of this.listeners.get('close') ?? []) listener({ code });
  }

  packet(body: unknown): void {
    for (const listener of this.listeners.get('message') ?? []) {
      listener({ data: JSON.stringify(body) });
    }
  }
}

describe('outbound Discord Gateway', () => {
  it('identifies without privileged intents and replies to an interaction through Discord HTTP', async () => {
    const socket = new FakeSocket();
    const requests: { url: string; method: string; body: unknown }[] = [];
    const fetcher = vi.fn((url: string | URL | Request, init?: RequestInit) => {
      const value = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
      if (value.endsWith('/gateway/bot')) {
        return Promise.resolve(
          new Response(JSON.stringify({ url: 'wss://gateway.discord.gg' }), { status: 200 }),
        );
      }
      requests.push({
        url: value,
        method: init?.method ?? 'GET',
        body: typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : null,
      });
      return Promise.resolve(new Response(null, { status: 204 }));
    });
    const commandHandle = vi.fn(() =>
      Promise.resolve({
        httpStatus: 200,
        body: { type: 4, data: { content: 'Rejected. Nothing was sent to the employer.' } },
      }),
    );
    const commands = {
      handle: commandHandle,
    } as unknown as DiscordCommandService;
    let gatewaySocketCreated = false;
    const gateway = new DiscordGateway({
      botToken: 'test-bot-token',
      commands,
      fetcher,
      socketFactory: () => {
        gatewaySocketCreated = true;
        return socket as unknown as WebSocket;
      },
    });
    try {
      gateway.start();
      await vi.waitFor(() => expect(gatewaySocketCreated).toBe(true));
      socket.packet({ op: 10, d: { heartbeat_interval: 45_000 } });
      expect(JSON.parse(socket.sent[0] ?? '{}')).toMatchObject({ op: 2, d: { intents: 0 } });
      socket.packet({
        op: 0,
        t: 'INTERACTION_CREATE',
        s: 1,
        d: {
          id: 'interaction-1',
          token: 'interaction-token',
          application_id: 'app-1',
          type: 2,
          member: { user: { id: 'owner-1' } },
          channel_id: 'channel-1',
          data: { name: 'job', options: [{ type: 1, name: 'reject' }] },
        },
      });
      await vi.waitFor(() => expect(requests).toHaveLength(2));
      expect(requests[0]).toMatchObject({ method: 'POST', body: { type: 5, data: { flags: 64 } } });
      expect(requests[1]).toMatchObject({
        method: 'PATCH',
        body: { content: 'Rejected. Nothing was sent to the employer.' },
      });
      expect(commandHandle).toHaveBeenCalledTimes(1);
    } finally {
      gateway.stop();
    }
  });
});
