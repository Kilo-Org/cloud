import { decryptWithSymmetricKey, encryptWithSymmetricKey } from '@kilocode/encryption';
import { USER_DELETION_ENCRYPTION_KEY } from '@/lib/config.server';

export class DeletionCryptoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DeletionCryptoError';
  }
}

function encryptionKey(raw = USER_DELETION_ENCRYPTION_KEY): string {
  if (!raw.trim()) {
    throw new DeletionCryptoError('USER_DELETION_ENCRYPTION_KEY is not configured');
  }
  return raw.trim();
}

export function encryptDeletionResourceIds(ids: readonly string[], key = encryptionKey()): string {
  if (ids.length === 0 || ids.length > 10) {
    throw new DeletionCryptoError('Deletion effect checkpoints may encrypt 1-10 resource IDs');
  }
  return encryptWithSymmetricKey(JSON.stringify(ids), key);
}

export function decryptDeletionResourceIds(ciphertext: string, key = encryptionKey()): string[] {
  const parsed: unknown = JSON.parse(decryptWithSymmetricKey(ciphertext, key));
  if (
    !Array.isArray(parsed) ||
    parsed.length === 0 ||
    parsed.length > 10 ||
    parsed.some(value => typeof value !== 'string' || value.length === 0)
  ) {
    throw new DeletionCryptoError('Encrypted deletion resource IDs are malformed');
  }
  return parsed;
}

export function encryptDeletionCredential(material: string, key = encryptionKey()): string {
  if (!material) {
    throw new DeletionCryptoError('Cannot encrypt empty provider credential');
  }
  return encryptWithSymmetricKey(material, key);
}

export function decryptDeletionCredential(ciphertext: string, key = encryptionKey()): string {
  const material = decryptWithSymmetricKey(ciphertext, key);
  if (!material) {
    throw new DeletionCryptoError('Decrypted provider credential is empty');
  }
  return material;
}
