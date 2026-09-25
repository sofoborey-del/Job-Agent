import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';

export type EncryptedEnvelope = {
  version: 1;
  algorithm: 'aes-256-gcm';
  keyId: string;
  iv: string;
  ciphertext: string;
  authTag: string;
};

export interface EncryptionKeyProvider {
  currentKeyId(): string;
  getKey(keyId: string): Buffer;
}

export class StaticEncryptionKeyProvider implements EncryptionKeyProvider {
  private readonly keys: ReadonlyMap<string, Buffer>;

  constructor(
    private readonly activeKeyId: string,
    keys: ReadonlyMap<string, Buffer>,
  ) {
    for (const [keyId, key] of keys) {
      if (key.length !== 32) throw new Error(`Encryption key ${keyId} must contain 32 bytes`);
    }
    if (!keys.has(activeKeyId)) throw new Error('The active encryption key is unavailable');
    this.keys = new Map(keys);
  }

  currentKeyId(): string {
    return this.activeKeyId;
  }

  getKey(keyId: string): Buffer {
    const key = this.keys.get(keyId);
    if (key === undefined) throw new Error('Requested encryption key is unavailable');
    return Buffer.from(key);
  }

  static fromBase64(keyId: string, encodedKey: string): StaticEncryptionKeyProvider {
    if (encodedKey.trim() === '') throw new Error('Encryption key must not be empty');
    const key = Buffer.from(encodedKey, 'base64');
    return new StaticEncryptionKeyProvider(keyId, new Map([[keyId, key]]));
  }
}

export class FieldCipher {
  constructor(private readonly keys: EncryptionKeyProvider) {}

  encryptJson(value: unknown, associatedData: string): EncryptedEnvelope {
    const plaintext = Buffer.from(JSON.stringify(value), 'utf8');
    try {
      return this.encryptBytes(plaintext, associatedData);
    } finally {
      plaintext.fill(0);
    }
  }

  encryptBytes(value: Uint8Array, associatedData: string): EncryptedEnvelope {
    const keyId = this.keys.currentKeyId();
    const key = this.keys.getKey(keyId);
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from(associatedData, 'utf8'));
    const ciphertext = Buffer.concat([cipher.update(value), cipher.final()]);
    const authTag = cipher.getAuthTag();
    key.fill(0);
    return {
      version: 1,
      algorithm: 'aes-256-gcm',
      keyId,
      iv: iv.toString('base64'),
      ciphertext: ciphertext.toString('base64'),
      authTag: authTag.toString('base64'),
    };
  }

  decryptJson(envelope: EncryptedEnvelope, associatedData: string): unknown {
    const plaintext = this.decryptBytes(envelope, associatedData);
    try {
      return JSON.parse(plaintext.toString('utf8')) as unknown;
    } finally {
      plaintext.fill(0);
    }
  }

  decryptBytes(envelope: EncryptedEnvelope, associatedData: string): Buffer {
    const key = this.keys.getKey(envelope.keyId);
    try {
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'));
      decipher.setAAD(Buffer.from(associatedData, 'utf8'));
      decipher.setAuthTag(Buffer.from(envelope.authTag, 'base64'));
      return Buffer.concat([
        decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
        decipher.final(),
      ]);
    } catch {
      throw new Error('Encrypted value failed authentication');
    } finally {
      key.fill(0);
    }
  }
}

export function secureTokenEquals(provided: string, expected: string): boolean {
  const providedBytes = Buffer.from(provided, 'utf8');
  const expectedBytes = Buffer.from(expected, 'utf8');
  if (providedBytes.length !== expectedBytes.length) return false;
  return timingSafeEqual(providedBytes, expectedBytes);
}

export function encodeEnvelope(envelope: EncryptedEnvelope): Buffer {
  return Buffer.from(JSON.stringify(envelope), 'utf8');
}

export function decodeEnvelope(encoded: Buffer): EncryptedEnvelope {
  const parsed = JSON.parse(encoded.toString('utf8')) as Partial<EncryptedEnvelope>;
  if (
    parsed.version !== 1 ||
    parsed.algorithm !== 'aes-256-gcm' ||
    typeof parsed.keyId !== 'string' ||
    typeof parsed.iv !== 'string' ||
    typeof parsed.ciphertext !== 'string' ||
    typeof parsed.authTag !== 'string'
  ) {
    throw new Error('Malformed encrypted envelope');
  }
  return parsed as EncryptedEnvelope;
}
