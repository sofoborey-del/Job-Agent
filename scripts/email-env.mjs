/**
 * Careful editing of the local .env file.
 *
 * The setup walkthrough writes credentials here so the person does not have to copy and paste them
 * between a browser, a terminal and an editor. That makes this file the one place in the repository
 * that rewrites a file full of secrets, so it is deliberately conservative:
 *
 * - every existing line is preserved byte for byte unless its key is being changed;
 * - only the value after the first `=` is replaced, so comments and ordering survive;
 * - the file's existing line endings are kept, because rewriting CRLF as LF would show up as a
 *   whole-file change in any editor the person has open;
 * - a copy is kept as .env.backup before the first write of a run, and `.env.*` is already ignored
 *   by git, so the backup cannot be committed by accident;
 * - no value is ever returned in a log line, an error message or a thrown string.
 */
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';

const KEY = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/;

/** Reads the file into its raw text, its line ending style, and a name-to-value map. */
export function readEnvFile(path) {
  const text = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  const values = new Map();
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trimStart();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const match = KEY.exec(trimmed);
    if (match) values.set(match[1], match[2]);
  }
  return { text, newline, values };
}

/** True when the key is present with a non-empty value. */
export function hasValue(path, key) {
  const value = readEnvFile(path).values.get(key);
  return value !== undefined && value.trim() !== '';
}

/**
 * Sets each key to its new value, in place. Returns which keys were changed and which were added,
 * by name only. Nothing is written when every value already matches.
 */
export function updateEnvFile(path, updates) {
  const { text, newline } = readEnvFile(path);
  const pending = new Map(Object.entries(updates));
  const changed = [];
  const added = [];

  const lines = text === '' ? [] : text.split(/\r?\n/);
  const rewritten = lines.map((line) => {
    const match = KEY.exec(line.trimStart());
    if (!match) return line;
    const key = match[1];
    if (!pending.has(key)) return line;
    const next = pending.get(key);
    pending.delete(key);
    if (match[2] === next) return line;
    changed.push(key);
    // Rebuilt from the key rather than patched, so trailing whitespace on the old value is dropped.
    const indent = line.slice(0, line.length - line.trimStart().length);
    return `${indent}${key}=${next}`;
  });

  for (const [key, value] of pending) {
    added.push(key);
    rewritten.push(`${key}=${value}`);
  }

  if (changed.length === 0 && added.length === 0) return { changed, added };

  if (existsSync(path)) copyFileSync(path, `${path}.backup`);
  // A single trailing newline, however the original ended.
  const body = rewritten.join(newline).replace(/(\r?\n)+$/, '');
  writeFileSync(path, `${body}${newline}`, 'utf8');
  return { changed, added };
}
