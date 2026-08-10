import { createCipheriv, randomBytes } from 'node:crypto';

import type { EncryptedData } from '@kilocode/db/schema-types';

export function requireEncryptionKey(): Buffer {
  const keyBase64 = process.env.BYOK_ENCRYPTION_KEY;
  if (!keyBase64) {
    throw new Error('BYOK_ENCRYPTION_KEY is not configured');
  }
  const key = Buffer.from(keyBase64, 'base64');
  if (key.length !== 32) {
    throw new Error('BYOK_ENCRYPTION_KEY must decode to 32 bytes');
  }
  return key;
}

export function encryptCredential(plaintext: string, key: Buffer): EncryptedData {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return {
    iv: iv.toString('base64'),
    data: encrypted.toString('base64'),
    authTag: cipher.getAuthTag().toString('base64'),
  };
}
