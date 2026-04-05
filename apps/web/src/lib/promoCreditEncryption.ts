import 'server-only';
import { encryptWithSymmetricKey, decryptWithSymmetricKey } from '@/lib/encryption';
import { CREDIT_CATEGORIES_ENCRYPTION_KEY } from '@/lib/config.server';

const getEncryptionKey = () => {
  if (!CREDIT_CATEGORIES_ENCRYPTION_KEY) {
    throw new Error('CREDIT_CATEGORIES_ENCRYPTION_KEY environment variable is required');
  }
  return CREDIT_CATEGORIES_ENCRYPTION_KEY;
};

/**
 * Encrypts a promo code using AES-256-GCM.
 * Used to encrypt promo codes before storing them in source code.
 *
 * @param plaintext - The plaintext promo code (e.g., "FOO", "BAR")
 * @returns Encrypted string in format iv:authTag:encrypted
 */
export function encryptPromoCode(plaintext: string): string {
  return encryptWithSymmetricKey(plaintext, getEncryptionKey());
}

/**
 * Decrypts an encrypted promo code.
 * Used at runtime to decrypt promo codes stored in source.
 *
 * @param encrypted - Encrypted string in format iv:authTag:encrypted
 * @returns The original plaintext promo code
 */
export function decryptPromoCode(encrypted: string): string {
  if (process.env.NODE_ENV === 'test' || CREDIT_CATEGORIES_ENCRYPTION_KEY === '') {
    return `TEST-PROMO-${Math.random().toString(36).substring(2, 8).toUpperCase()}`;
  }

  return decryptWithSymmetricKey(encrypted, getEncryptionKey());
}

/**
 * Checks if a value looks like an encrypted promo code.
 * AES-256-GCM format is iv:authTag:encrypted (3 base64 parts separated by colons).
 *
 * @param value - The value to check
 * @returns true if the value appears to be encrypted
 */
export function isEncryptedPromoCode(value: string): boolean {
  const parts = value.split(':');
  if (parts.length !== 3) return false;

  // Check that each part looks like valid base64
  const base64Regex = /^[A-Za-z0-9+/]+=*$/;
  return parts.every(part => base64Regex.test(part) && part.length > 0);
}
