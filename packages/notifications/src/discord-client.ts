import { redact, silentLogger, type StructuredLogger } from '@job-agent/observability';

export type DiscordDeliveryResult =
  | { status: 'delivered' }
  | { status: 'retry'; errorCode: string; retryAfterMs: number }
  | { status: 'permanent'; errorCode: string };

export type DiscordClientOptions = {
  botToken: string;
  channelId: string;
  fetcher?: typeof fetch;
  logger?: StructuredLogger;
  baseUrl?: string;
};

const DEFAULT_BASE_URL = 'https://discord.com/api/v10';

/**
 * Minimal outbound Discord client. It only posts messages to one configured channel and never
 * reads channel history, members or other guild data.
 */
export class DiscordClient {
  private readonly logger: StructuredLogger;

  constructor(private readonly options: DiscordClientOptions) {
    this.logger = options.logger ?? silentLogger;
  }

  async sendMessage(content: string): Promise<DiscordDeliveryResult> {
    const fetcher = this.options.fetcher ?? fetch;
    const url = `${this.options.baseUrl ?? DEFAULT_BASE_URL}/channels/${this.options.channelId}/messages`;
    let response: Response;
    try {
      response = await fetcher(url, {
        method: 'POST',
        headers: {
          authorization: `Bot ${this.options.botToken}`,
          'content-type': 'application/json',
          'user-agent': 'JobApplicationAgent/0.1 (personal, single user)',
        },
        body: JSON.stringify({
          content: content.slice(0, 1900),
          allowed_mentions: { parse: [] },
        }),
      });
    } catch (error) {
      this.logger.log('warn', 'Discord delivery failed before a response', {
        errorMessage: redact(error instanceof Error ? error.message : 'unknown'),
      });
      return { status: 'retry', errorCode: 'network_error', retryAfterMs: 30_000 };
    }

    if (response.ok) return { status: 'delivered' };
    if (response.status === 429) {
      const retryAfter = Number(response.headers.get('retry-after') ?? '5');
      return {
        status: 'retry',
        errorCode: 'rate_limited',
        retryAfterMs:
          Math.min(Math.max(Number.isFinite(retryAfter) ? retryAfter : 5, 1), 900) * 1000,
      };
    }
    if (response.status >= 500) {
      return {
        status: 'retry',
        errorCode: `http_${String(response.status)}`,
        retryAfterMs: 60_000,
      };
    }
    return { status: 'permanent', errorCode: `http_${String(response.status)}` };
  }
}
