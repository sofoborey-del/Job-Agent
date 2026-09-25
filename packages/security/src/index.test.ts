import { randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  FieldCipher,
  StaticEncryptionKeyProvider,
  decodeEnvelope,
  encodeEnvelope,
  secureTokenEquals,
} from './index.js';

function createCipher(): FieldCipher {
  return new FieldCipher(
    new StaticEncryptionKeyProvider('test-v1', new Map([['test-v1', randomBytes(32)]])),
  );
}

describe('field encryption', () => {
  it('round trips JSON through a serialised authenticated envelope', () => {
    const cipher = createCipher();
    const encrypted = cipher.encryptJson({ answer: 'synthetic' }, 'user-1|fact-1|1');
    const stored = encodeEnvelope(encrypted);
    expect(stored.toString('utf8')).not.toContain('synthetic');
    expect(cipher.decryptJson(decodeEnvelope(stored), 'user-1|fact-1|1')).toEqual({
      answer: 'synthetic',
    });
  });

  it('rejects tampering and moving ciphertext between records', () => {
    const cipher = createCipher();
    const encrypted = cipher.encryptJson('synthetic', 'user-1|fact-1|1');
    expect(() => cipher.decryptJson(encrypted, 'user-1|fact-2|1')).toThrow(
      'Encrypted value failed authentication',
    );
    const tamperedBytes = Buffer.from(encrypted.ciphertext, 'base64');
    tamperedBytes[0] = (tamperedBytes[0] ?? 0) ^ 1;
    expect(() =>
      cipher.decryptJson(
        { ...encrypted, ciphertext: tamperedBytes.toString('base64') },
        'user-1|fact-1|1',
      ),
    ).toThrow('Encrypted value failed authentication');
  });
});

describe('constant-time token comparison', () => {
  it('accepts exact tokens and rejects different values or lengths', () => {
    expect(secureTokenEquals('token-1', 'token-1')).toBe(true);
    expect(secureTokenEquals('token-2', 'token-1')).toBe(false);
    expect(secureTokenEquals('short', 'longer')).toBe(false);
  });
});
