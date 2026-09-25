import { createHash, createPublicKey, verify as verifySignature } from 'node:crypto';

const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const MAX_TIMESTAMP_SKEW_SECONDS = 300;

export const InteractionType = {
  Ping: 1,
  ApplicationCommand: 2,
  MessageComponent: 3,
} as const;

export const InteractionResponseType = {
  Pong: 1,
  ChannelMessageWithSource: 4,
} as const;

const EPHEMERAL_FLAG = 64;

export type VerificationResult =
  | { valid: true }
  | {
      valid: false;
      reason: 'malformed_key' | 'bad_signature' | 'stale_timestamp' | 'missing_headers';
    };

/**
 * Verifies a Discord interaction exactly as Discord documents it: Ed25519 over
 * timestamp + raw body, using the application public key, with a timestamp freshness check so a
 * captured request cannot be replayed indefinitely.
 */
export function verifyInteractionSignature(input: {
  publicKeyHex: string;
  signatureHex: string | undefined;
  timestamp: string | undefined;
  rawBody: string;
  now?: Date;
}): VerificationResult {
  if (
    input.signatureHex === undefined ||
    input.timestamp === undefined ||
    input.signatureHex === '' ||
    input.timestamp === ''
  ) {
    return { valid: false, reason: 'missing_headers' };
  }
  const timestampSeconds = Number(input.timestamp);
  if (!Number.isFinite(timestampSeconds)) return { valid: false, reason: 'stale_timestamp' };
  const nowSeconds = Math.floor((input.now ?? new Date()).getTime() / 1000);
  if (Math.abs(nowSeconds - timestampSeconds) > MAX_TIMESTAMP_SKEW_SECONDS) {
    return { valid: false, reason: 'stale_timestamp' };
  }
  if (!/^[0-9a-f]{64}$/i.test(input.publicKeyHex)) return { valid: false, reason: 'malformed_key' };
  if (!/^[0-9a-f]{128}$/i.test(input.signatureHex))
    return { valid: false, reason: 'bad_signature' };

  let keyObject;
  try {
    keyObject = createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(input.publicKeyHex, 'hex')]),
      format: 'der',
      type: 'spki',
    });
  } catch {
    return { valid: false, reason: 'malformed_key' };
  }

  const signed = Buffer.from(input.timestamp + input.rawBody, 'utf8');
  const signature = Buffer.from(input.signatureHex, 'hex');
  const valid = verifySignature(null, signed, keyObject, signature);
  return valid ? { valid: true } : { valid: false, reason: 'bad_signature' };
}

export type ParsedInteraction = {
  id: string;
  type: number;
  userId: string | null;
  channelId: string | null;
  guildId: string | null;
  commandName: string | null;
  subCommand: string | null;
  options: Record<string, string>;
};

function optionRecord(value: unknown): Record<string, string> {
  if (!Array.isArray(value)) return {};
  const output: Record<string, string> = {};
  for (const option of value) {
    if (typeof option !== 'object' || option === null) continue;
    const entry = option as Record<string, unknown>;
    const name = typeof entry.name === 'string' ? entry.name : null;
    if (name === null) continue;
    if (typeof entry.value === 'string') output[name] = entry.value;
    else if (typeof entry.value === 'number') output[name] = String(entry.value);
  }
  return output;
}

export function parseInteraction(body: unknown): ParsedInteraction | null {
  if (typeof body !== 'object' || body === null) return null;
  const record = body as Record<string, unknown>;
  const id = typeof record.id === 'string' ? record.id : null;
  const type = typeof record.type === 'number' ? record.type : null;
  if (id === null || type === null) return null;

  const member =
    typeof record.member === 'object' && record.member !== null
      ? (record.member as Record<string, unknown>)
      : null;
  const memberUser =
    member !== null && typeof member.user === 'object' && member.user !== null
      ? (member.user as Record<string, unknown>)
      : null;
  const directUser =
    typeof record.user === 'object' && record.user !== null
      ? (record.user as Record<string, unknown>)
      : null;
  const userId =
    typeof memberUser?.id === 'string'
      ? memberUser.id
      : typeof directUser?.id === 'string'
        ? directUser.id
        : null;

  const data =
    typeof record.data === 'object' && record.data !== null
      ? (record.data as Record<string, unknown>)
      : null;
  const commandName = typeof data?.name === 'string' ? data.name : null;
  const rawOptions = Array.isArray(data?.options) ? data.options : [];
  const firstOption =
    rawOptions.length > 0 && typeof rawOptions[0] === 'object' && rawOptions[0] !== null
      ? (rawOptions[0] as Record<string, unknown>)
      : null;
  const isSubCommand = firstOption !== null && firstOption.type === 1;

  return {
    id,
    type,
    userId,
    channelId: typeof record.channel_id === 'string' ? record.channel_id : null,
    guildId: typeof record.guild_id === 'string' ? record.guild_id : null,
    commandName,
    subCommand: isSubCommand && typeof firstOption.name === 'string' ? firstOption.name : null,
    options: isSubCommand ? optionRecord(firstOption.options) : optionRecord(data?.options),
  };
}

export function interactionPayloadHash(rawBody: string): string {
  return createHash('sha256').update(rawBody).digest('hex');
}

export function ephemeralReply(content: string): {
  type: number;
  data: { content: string; flags: number; allowed_mentions: { parse: string[] } };
} {
  return {
    type: InteractionResponseType.ChannelMessageWithSource,
    data: {
      content: content.slice(0, 1900),
      flags: EPHEMERAL_FLAG,
      allowed_mentions: { parse: [] },
    },
  };
}

export function pong(): { type: number } {
  return { type: InteractionResponseType.Pong };
}
