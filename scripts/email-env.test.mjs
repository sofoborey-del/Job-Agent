import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { hasValue, readEnvFile, updateEnvFile } from './email-env.mjs';

/**
 * The setup walkthrough rewrites the one file in this project that holds every local secret, so the
 * rules it follows are worth pinning: never lose a line, never lose a comment, never change a value
 * nobody asked about, and never change the file's line endings.
 *
 * Every value here is invented.
 */

function envFile(contents) {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'env-test-')), '.env');
  writeFileSync(file, contents, 'utf8');
  return file;
}

const sample = [
  '# Local settings. Comments matter.',
  'DB_MODE=embedded',
  '',
  '# Discord',
  'DISCORD_BOT_TOKEN=invented-token-value',
  'GMAIL_CLIENT_ID=',
  '',
].join('\n');

describe('reading .env', () => {
  it('reads values and ignores comments and blank lines', () => {
    const { values } = readEnvFile(envFile(sample));
    expect(values.get('DB_MODE')).toBe('embedded');
    expect(values.get('GMAIL_CLIENT_ID')).toBe('');
    expect(values.has('# Discord')).toBe(false);
  });

  it('treats a present-but-empty key as unset', () => {
    const file = envFile(sample);
    expect(hasValue(file, 'DB_MODE')).toBe(true);
    expect(hasValue(file, 'GMAIL_CLIENT_ID')).toBe(false);
    expect(hasValue(file, 'NOT_THERE_AT_ALL')).toBe(false);
  });

  it('copes with no file at all', () => {
    const missing = path.join(mkdtempSync(path.join(tmpdir(), 'env-test-')), '.env');
    expect(readEnvFile(missing).text).toBe('');
    expect(hasValue(missing, 'DB_MODE')).toBe(false);
  });
});

describe('writing .env', () => {
  it('fills an existing empty key in place, touching nothing else', () => {
    const file = envFile(sample);
    const result = updateEnvFile(file, { GMAIL_CLIENT_ID: 'invented.apps.googleusercontent.com' });

    expect(result).toEqual({ changed: ['GMAIL_CLIENT_ID'], added: [] });
    const written = readFileSync(file, 'utf8');
    expect(written).toContain('GMAIL_CLIENT_ID=invented.apps.googleusercontent.com');
    expect(written).toContain('# Local settings. Comments matter.');
    expect(written).toContain('# Discord');
    expect(written).toContain('DISCORD_BOT_TOKEN=invented-token-value');
    // The order of the original lines is unchanged.
    expect(written.indexOf('DB_MODE')).toBeLessThan(written.indexOf('DISCORD_BOT_TOKEN'));
  });

  it('appends a key the file does not have yet', () => {
    const file = envFile(sample);
    const result = updateEnvFile(file, { GMAIL_REFRESH_TOKEN: 'invented-refresh-value' });

    expect(result).toEqual({ changed: [], added: ['GMAIL_REFRESH_TOKEN'] });
    expect(readFileSync(file, 'utf8')).toContain('GMAIL_REFRESH_TOKEN=invented-refresh-value');
  });

  it('keeps a backup before the first change', () => {
    const file = envFile(sample);
    updateEnvFile(file, { DB_MODE: 'postgres' });
    expect(existsSync(`${file}.backup`)).toBe(true);
    expect(readFileSync(`${file}.backup`, 'utf8')).toBe(sample);
  });

  it('writes nothing at all when every value already matches', () => {
    const file = envFile(sample);
    const result = updateEnvFile(file, { DB_MODE: 'embedded' });
    expect(result).toEqual({ changed: [], added: [] });
    // No write means no backup, which is how a re-run of the walkthrough stays harmless.
    expect(existsSync(`${file}.backup`)).toBe(false);
    expect(readFileSync(file, 'utf8')).toBe(sample);
  });

  it('preserves CRLF line endings rather than rewriting the whole file', () => {
    const file = envFile(sample.split('\n').join('\r\n'));
    updateEnvFile(file, { GMAIL_CLIENT_ID: 'invented' });
    const written = readFileSync(file, 'utf8');
    expect(written).toContain('\r\n');
    expect(written.replace(/\r\n/g, '')).not.toContain('\n');
  });

  it('does not mistake a value containing = for two settings', () => {
    const file = envFile('APP_ENCRYPTION_KEY_BASE64=abc==\n');
    updateEnvFile(file, { EMAIL_PROVIDER: 'gmail' });
    const written = readFileSync(file, 'utf8');
    expect(written).toContain('APP_ENCRYPTION_KEY_BASE64=abc==');
    expect(written).toContain('EMAIL_PROVIDER=gmail');
  });

  it('leaves a commented-out key commented, and adds the real one', () => {
    const file = envFile('# EMAIL_PROVIDER=something\n');
    updateEnvFile(file, { EMAIL_PROVIDER: 'gmail' });
    const written = readFileSync(file, 'utf8');
    expect(written).toContain('# EMAIL_PROVIDER=something');
    expect(written).toContain('\nEMAIL_PROVIDER=gmail');
  });

  it('ends the file with exactly one newline', () => {
    const file = envFile('DB_MODE=embedded\n\n\n');
    updateEnvFile(file, { DB_MODE: 'postgres' });
    expect(readFileSync(file, 'utf8')).toBe('DB_MODE=postgres\n');
  });
});
