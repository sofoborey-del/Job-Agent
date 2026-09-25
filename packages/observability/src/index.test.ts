import { describe, expect, it } from 'vitest';

import { MetricCounters, redact, RedactingLogger, REDACTED } from './index.js';

describe('redaction', () => {
  it('removes values held under obviously sensitive keys', () => {
    const output = redact({
      botToken: 'abc',
      nested: { authorization: 'Bearer xyz', jobTitle: 'Compliance Officer' },
      list: [{ password: 'hunter2' }],
    });
    expect(output).toEqual({
      botToken: REDACTED,
      nested: { authorization: REDACTED, jobTitle: 'Compliance Officer' },
      list: [{ password: REDACTED }],
    });
  });

  it('removes a known secret wherever it appears in text', () => {
    const secret = 'MTIzNDU2Nzg5MDEyMzQ1Njc4';
    const output = redact(`failed with token ${secret}`, [secret]);
    expect(output).toBe(`failed with token ${REDACTED}`);
  });

  it('removes bearer tokens that were never declared as secrets', () => {
    expect(redact('Authorization was Bearer abc.def-ghi')).toBe(`Authorization was ${REDACTED}`);
  });
});

describe('redacting logger', () => {
  it('redacts fields before they reach the sink', () => {
    const entries: unknown[] = [];
    const logger = new RedactingLogger((entry) => entries.push(entry), ['supersecretvalue']);
    logger.child({ correlationId: 'abc' }).log('info', 'delivering', {
      botToken: 'supersecretvalue',
      jobId: 'job-1',
    });
    expect(entries).toHaveLength(1);
    expect(JSON.stringify(entries[0])).not.toContain('supersecretvalue');
    expect(JSON.stringify(entries[0])).toContain('job-1');
  });
});

describe('counters', () => {
  it('sums and snapshots metric names', () => {
    const counters = new MetricCounters();
    counters.increment('discovery.fetched', 2);
    counters.increment('discovery.fetched');
    expect(counters.get('discovery.fetched')).toBe(3);
    expect(counters.snapshot()).toEqual({ 'discovery.fetched': 3 });
  });
});
