import { redact, silentLogger, type StructuredLogger } from '@job-agent/observability';

import type { DiscordCommandService } from './discord-commands.js';

type GatewayPacket = { op?: number; d?: unknown; s?: number | null; t?: string };

export type DiscordGatewayOptions = {
  botToken: string;
  commands: DiscordCommandService;
  logger?: StructuredLogger;
  fetcher?: typeof fetch;
  socketFactory?: (url: URL) => WebSocket;
};

/** Outbound-only Discord interaction receiver. No HTTP listener is created. */
export class DiscordGateway {
  private readonly logger: StructuredLogger;
  private socket: WebSocket | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private stopped = true;
  private acknowledged = true;
  private sequence: number | null = null;
  private sessionId: string | null = null;
  private resumeUrl: string | null = null;
  private backoffMs = 1_000;

  constructor(private readonly options: DiscordGatewayOptions) {
    this.logger = options.logger ?? silentLogger;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    void this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.retry !== null) clearTimeout(this.retry);
    if (this.heartbeat !== null) clearInterval(this.heartbeat);
    this.retry = null;
    this.heartbeat = null;
    this.socket?.close(1000);
    this.socket = null;
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    try {
      let gatewayUrl = this.resumeUrl;
      if (gatewayUrl === null) {
        const response = await (this.options.fetcher ?? fetch)(
          'https://discord.com/api/v10/gateway/bot',
          { headers: { authorization: `Bot ${this.options.botToken}` } },
        );
        if (!response.ok) throw new Error(`gateway discovery HTTP ${String(response.status)}`);
        const body = (await response.json()) as { url?: unknown };
        if (typeof body.url !== 'string') throw new Error('gateway URL missing');
        gatewayUrl = body.url;
      }
      const url = new URL(gatewayUrl);
      if (url.protocol !== 'wss:' || url.hostname !== 'gateway.discord.gg') {
        throw new Error('unexpected gateway host');
      }
      url.searchParams.set('v', '10');
      url.searchParams.set('encoding', 'json');
      const socket = this.options.socketFactory?.(url) ?? new WebSocket(url);
      this.socket = socket;
      socket.addEventListener('message', (event) => {
        if (typeof event.data !== 'string') return;
        try {
          this.onPacket(JSON.parse(event.data) as GatewayPacket, socket);
        } catch {
          this.logger.log('warn', 'Discord gateway sent an invalid packet');
        }
      });
      socket.addEventListener('close', (event) => {
        if (this.socket !== socket) return;
        this.socket = null;
        if (this.heartbeat !== null) clearInterval(this.heartbeat);
        this.heartbeat = null;
        if ([4007, 4009].includes(event.code)) this.clearSession();
        if ([4004, 4010, 4011, 4012, 4013, 4014].includes(event.code)) {
          this.logger.log('error', 'Discord gateway authentication or intents rejected', {
            closeCode: event.code,
          });
          this.stop();
          return;
        }
        this.scheduleReconnect();
      });
      socket.addEventListener('error', () => {
        this.logger.log('warn', 'Discord gateway socket error');
      });
    } catch (error) {
      this.logger.log('warn', 'Discord gateway connection failed', {
        errorMessage: redact(error instanceof Error ? error.message : 'unknown'),
      });
      this.scheduleReconnect();
    }
  }

  private onPacket(packet: GatewayPacket, socket: WebSocket): void {
    if (typeof packet.s === 'number') this.sequence = packet.s;
    if (packet.op === 10) {
      const data = packet.d as { heartbeat_interval?: unknown } | null;
      const interval = data?.heartbeat_interval;
      if (typeof interval !== 'number' || interval < 1_000) {
        socket.close();
        return;
      }
      this.acknowledged = true;
      if (this.heartbeat !== null) clearInterval(this.heartbeat);
      this.heartbeat = setInterval(() => this.sendHeartbeat(socket), interval);
      setTimeout(() => this.sendHeartbeat(socket), Math.floor(Math.random() * interval));
      if (this.sessionId !== null && this.resumeUrl !== null) {
        this.send(socket, {
          op: 6,
          d: { token: this.options.botToken, session_id: this.sessionId, seq: this.sequence },
        });
      } else {
        this.send(socket, {
          op: 2,
          d: {
            token: this.options.botToken,
            intents: 0,
            properties: { os: 'linux', browser: 'job-agent', device: 'job-agent' },
          },
        });
      }
    } else if (packet.op === 11) {
      this.acknowledged = true;
    } else if (packet.op === 1) {
      this.sendHeartbeat(socket);
    } else if (packet.op === 7) {
      socket.close();
    } else if (packet.op === 9) {
      if (packet.d !== true) this.clearSession();
      socket.close();
    } else if (packet.op === 0 && packet.t === 'READY') {
      const data = packet.d as { session_id?: unknown; resume_gateway_url?: unknown } | null;
      this.sessionId = typeof data?.session_id === 'string' ? data.session_id : null;
      this.resumeUrl =
        typeof data?.resume_gateway_url === 'string' ? data.resume_gateway_url : null;
      this.backoffMs = 1_000;
    } else if (packet.op === 0 && packet.t === 'RESUMED') {
      this.backoffMs = 1_000;
    } else if (packet.op === 0 && packet.t === 'INTERACTION_CREATE') {
      void this.handleInteraction(packet.d);
    }
  }

  private sendHeartbeat(socket: WebSocket): void {
    if (socket.readyState !== WebSocket.OPEN) return;
    if (!this.acknowledged) {
      socket.close();
      return;
    }
    this.acknowledged = false;
    this.send(socket, { op: 1, d: this.sequence });
  }

  private send(socket: WebSocket, body: unknown): void {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(body));
  }

  private async handleInteraction(body: unknown): Promise<void> {
    if (typeof body !== 'object' || body === null) return;
    const interaction = body as {
      id?: unknown;
      token?: unknown;
      type?: unknown;
      application_id?: unknown;
    };
    if (typeof interaction.id !== 'string' || typeof interaction.token !== 'string') return;
    const endpoint = `https://discord.com/api/v10/interactions/${encodeURIComponent(interaction.id)}/${encodeURIComponent(interaction.token)}/callback`;
    const fetcher = this.options.fetcher ?? fetch;
    let deferred = false;
    try {
      const initial = await fetcher(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(
          interaction.type === 1 ? { type: 1 } : { type: 5, data: { flags: 64 } },
        ),
      });
      if (!initial.ok)
        throw new Error(`interaction acknowledgement HTTP ${String(initial.status)}`);
      if (interaction.type === 1) return;
      deferred = true;
      const outcome = await this.options.commands.handle({ rawBody: JSON.stringify(body) });
      const content = (outcome.body.data as { content?: unknown } | undefined)?.content;
      if (typeof interaction.application_id !== 'string') throw new Error('application ID missing');
      const response = await fetcher(
        `https://discord.com/api/v10/webhooks/${encodeURIComponent(interaction.application_id)}/${encodeURIComponent(interaction.token)}/messages/@original`,
        {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            content: typeof content === 'string' ? content : 'Command could not be completed.',
            allowed_mentions: { parse: [] },
          }),
        },
      );
      if (!response.ok) throw new Error(`interaction reply HTTP ${String(response.status)}`);
    } catch (error) {
      this.logger.log('warn', 'Discord interaction failed', {
        errorMessage: redact(error instanceof Error ? error.message : 'unknown'),
      });
      if (deferred && typeof interaction.application_id === 'string') {
        await fetcher(
          `https://discord.com/api/v10/webhooks/${encodeURIComponent(interaction.application_id)}/${encodeURIComponent(interaction.token)}/messages/@original`,
          {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              content: 'I could not complete that command. Check the tracker before trying again.',
              allowed_mentions: { parse: [] },
            }),
          },
        ).catch(() => undefined);
      }
    }
  }

  private clearSession(): void {
    this.sessionId = null;
    this.resumeUrl = null;
    this.sequence = null;
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.retry !== null) return;
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, 30_000);
    this.retry = setTimeout(() => {
      this.retry = null;
      void this.connect();
    }, delay);
  }
}
