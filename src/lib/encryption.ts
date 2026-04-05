/**
 * Re-exports from @kilocode/encryption.
 *
 * All encryption logic lives in the shared package; this file exists so that
 * existing imports from `@/lib/encryption` continue to work without changes.
 */
export {
  EncryptionConfigurationError,
  EncryptionFormatError,
  encryptWithPublicKey,
  decryptWithPrivateKey,
  encryptWithSymmetricKey,
  decryptWithSymmetricKey,
  decryptSecrets,
  mergeEnvVarsWithSecrets,
} from '@kilocode/encryption';

export type { EncryptedEnvelope } from '@kilocode/encryption';
