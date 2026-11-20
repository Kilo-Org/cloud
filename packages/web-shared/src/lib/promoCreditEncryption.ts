import 'server-only';
import {
  decryptWithSymmetricKey,
  EncryptionConfigurationError,
  EncryptionFormatError,
} from '@kilocode/web-shared/lib/encryption';
import {
  CREDIT_CATEGORIES_ENCRYPTION_KEY,
  CREDIT_CATEGORIES_ENCRYPTION_KEY_V2,
} from '@kilocode/web-shared/lib/config.server';

const getEncryptionKey = () => {
  const encryptionKey = CREDIT_CATEGORIES_ENCRYPTION_KEY_V2 || CREDIT_CATEGORIES_ENCRYPTION_KEY;
  if (!encryptionKey) {
    throw new Error(
      'CREDIT_CATEGORIES_ENCRYPTION_KEY_V2 or CREDIT_CATEGORIES_ENCRYPTION_KEY environment variable is required'
    );
  }
  return encryptionKey;
};

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
