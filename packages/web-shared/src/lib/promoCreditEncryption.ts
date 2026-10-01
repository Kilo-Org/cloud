import 'server-only';
import {
  encryptWithSymmetricKey,
  decryptWithSymmetricKey,
  EncryptionConfigurationError,
  EncryptionFormatError,
} from '@/lib/encryption';
import {
  CREDIT_CATEGORIES_ENCRYPTION_KEY,
  CREDIT_CATEGORIES_ENCRYPTION_KEY_V2,
} from '@/lib/config.server';

const getEncryptionKey = () => {
  const encryptionKey = CREDIT_CATEGORIES_ENCRYPTION_KEY_V2 || CREDIT_CATEGORIES_ENCRYPTION_KEY;
  if (!encryptionKey) {
    throw new Error(
      'CREDIT_CATEGORIES_ENCRYPTION_KEY_V2 or CREDIT_CATEGORIES_ENCRYPTION_KEY environment variable is required'
    );
  }
  return encryptionKey;
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

function placeholderPromoCode(): string {
  return `TEST-PROMO-${Math.random().toString(36).substring(2, 8).toUpperCase()}`;
}

/**
 * Decrypts an encrypted promo code.
 * Used at runtime to decrypt promo codes stored in source.
 *
 * The promo codes committed in source are encrypted with the deployment key.
 * A development environment only ever has the key it pulled from Vercel, and
 * `.env.local.example` tells developers to generate one when it is missing, so
 * a configured key that cannot decrypt these ciphertexts is expected outside
 * production. `promoCreditCategories` decrypts at module load, so letting one
 * undecryptable entry throw takes down every route that imports the catalogue
 * (native sign-in, session preparation). Fall back to a placeholder outside
 * production for that expected mismatch; production still fails loudly.
 *
 * A malformed stored value (`EncryptionFormatError`) or an invalid key
 * (`EncryptionConfigurationError`) is a data-entry or configuration mistake
 * rather than the expected key/ciphertext mismatch, so it is thrown everywhere
 * instead of being replaced by a placeholder.
 *
 * @param encrypted - Encrypted string in format iv:authTag:encrypted
 * @returns The original plaintext promo code
 */
export function decryptPromoCode(encrypted: string): string {
  if (
    process.env.NODE_ENV === 'test' ||
    (!CREDIT_CATEGORIES_ENCRYPTION_KEY_V2 && !CREDIT_CATEGORIES_ENCRYPTION_KEY)
  ) {
    return placeholderPromoCode();
  }

  try {
    return decryptWithSymmetricKey(encrypted, getEncryptionKey());
  } catch (error) {
    if (
      error instanceof EncryptionFormatError ||
      error instanceof EncryptionConfigurationError ||
      process.env.NODE_ENV === 'production'
    ) {
      throw error;
    }
    console.warn(
      '[promo-credits] CREDIT_CATEGORIES_ENCRYPTION_KEY cannot decrypt a stored promo code; using a placeholder outside production',
      error
    );
    return placeholderPromoCode();
  }
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
