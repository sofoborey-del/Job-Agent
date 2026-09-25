import { randomUUID } from 'node:crypto';

/** A correlation id follows one unit of work from discovery through notification. */
export function newCorrelationId(): string {
  return randomUUID();
}

export const REDACTED = '[redacted]';

const sensitiveKeyPattern =
  /(token|secret|password|passphrase|authorization|cookie|credential|api[-_]?key|encryption[-_]?key|ciphertext|signature|session)/i;

const sensitiveValuePatterns: readonly RegExp[] = [
  /\b[A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{27,}\b/g, // bot/JWT style tokens
  /\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi,
];

function redactString(value: string, extraSecrets: readonly string[]): string {
  let output = value;
  for (const secret of extraSecrets) {
    if (secret.length < 8) continue;
    output = output.split(secret).join(REDACTED);
  }
  for (const pattern of sensitiveValuePatterns) {
    output = output.replace(pattern, REDACTED);
  }
  return output;
}

/**
 * Deeply copies a value, replacing anything that looks like a secret with a placeholder.
 * Used before writing logs, notification payloads or error responses.
 */
export function redact(value: unknown, extraSecrets: readonly string[] = [], depth = 0): unknown {
  if (depth > 8) return REDACTED;
  if (typeof value === 'string') return redactString(value, extraSecrets);
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value;
  if (value === undefined) return undefined;
  if (Array.isArray(value)) return value.map((item) => redact(item, extraSecrets, depth + 1));
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') {
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      output[key] = sensitiveKeyPattern.test(key)
        ? REDACTED
        : redact(item, extraSecrets, depth + 1);
    }
    return output;
  }
  return REDACTED;
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export type LogFields = Record<string, unknown>;

export interface StructuredLogger {
  log(level: LogLevel, message: string, fields?: LogFields): void;
  child(fields: LogFields): StructuredLogger;
}

export type LogSink = (entry: {
  level: LogLevel;
  message: string;
  fields: LogFields;
  time: string;
}) => void;

/** A logger that redacts every field before it reaches the sink. */
export class RedactingLogger implements StructuredLogger {
  constructor(
    private readonly sink: LogSink,
    private readonly secrets: readonly string[] = [],
    private readonly baseFields: LogFields = {},
  ) {}

  log(level: LogLevel, message: string, fields: LogFields = {}): void {
    const merged = { ...this.baseFields, ...fields };
    this.sink({
      level,
      message: redactString(message, this.secrets),
      fields: redact(merged, this.secrets) as LogFields,
      time: new Date().toISOString(),
    });
  }

  child(fields: LogFields): StructuredLogger {
    return new RedactingLogger(this.sink, this.secrets, { ...this.baseFields, ...fields });
  }
}

export const silentLogger: StructuredLogger = {
  log: () => undefined,
  child: () => silentLogger,
};

/** Small in-process counters. Metric names never contain applicant values. */
export class MetricCounters {
  private readonly values = new Map<string, number>();

  increment(name: string, by = 1): void {
    this.values.set(name, (this.values.get(name) ?? 0) + by);
  }

  get(name: string): number {
    return this.values.get(name) ?? 0;
  }

  snapshot(): Record<string, number> {
    return Object.fromEntries([...this.values.entries()].sort(([a], [b]) => a.localeCompare(b)));
  }
}
