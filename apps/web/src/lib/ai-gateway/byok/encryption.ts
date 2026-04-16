import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';
export type { EncryptedData } from '@kilocode/db/schema-types';
import type { EncryptedData } from '@kilocode/db/schema-types';

/**
 * Encrypts a string using AES-256-GCM with the provided key
 *
 * @param plaintext - The string to encrypt
 * @param keyBase64 - Base64-encoded 32-byte encryption key
 * @returns EncryptedData object containing IV, encrypted data, and auth tag
 */
export function encryptApiKey(plaintext: string, keyBase64: string): EncryptedData {
  // Decode the base64 key
  const key = Buffer.from(keyBase64, 'base64');

  if (key.length !== 32) {
    throw new Error('Encryption key must be 32 bytes (256 bits)');
  }

  // Generate random IV (12 bytes is recommended for GCM)
  const iv = randomBytes(12);

  // Create cipher
  const cipher = createCipheriv('aes-256-gcm', key, iv);

  // Encrypt the data
  let encrypted = cipher.update(plaintext, 'utf8');
  encrypted = Buffer.concat([encrypted, cipher.final()]);

  // Get the authentication tag
  const authTag = cipher.getAuthTag();

  return {
    iv: iv.toString('base64'),
    data: encrypted.toString('base64'),
    authTag: authTag.toString('base64'),
  };
}

/**
 * Decrypts data that was encrypted with encryptApiKey
 *
 * @param encrypted - The EncryptedData object to decrypt
 * @param keyBase64 - Base64-encoded 32-byte encryption key
 * @returns The decrypted plaintext string
 */
export function decryptApiKey(encrypted: EncryptedData, keyBase64: string): string {
  // Decode the base64 key
  const key = Buffer.from(keyBase64, 'base64');

  if (key.length !== 32) {
    throw new Error('Encryption key must be 32 bytes (256 bits)');
  }

  // Decode the encrypted data components
  const iv = Buffer.from(encrypted.iv, 'base64');
  const encryptedData = Buffer.from(encrypted.data, 'base64');
  const authTag = Buffer.from(encrypted.authTag, 'base64');

  // Create decipher
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);

  // Decrypt the data
  let decrypted = decipher.update(encryptedData, undefined, 'utf8');
  decrypted += decipher.final('utf8');

  return decrypted;
}

/**
 * Generates a random 32-byte (256-bit) encryption key encoded as base64
 * This is a utility function for generating new keys
 *
 * @returns Base64-encoded 32-byte key
 */
export function generateEncryptionKey(): string {
  return randomBytes(32).toString('base64');
}
