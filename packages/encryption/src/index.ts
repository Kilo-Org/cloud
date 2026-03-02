export {
  // Error classes
  EncryptionConfigurationError,
  EncryptionFormatError,

  // RSA envelope encryption
  encryptWithPublicKey,
  decryptWithPrivateKey,

  // Symmetric encryption
  encryptWithSymmetricKey,
  decryptWithSymmetricKey,

  // Batch helpers
  decryptSecrets,
  mergeEnvVarsWithSecrets,
} from './encryption';

export type { EncryptedEnvelope } from './encryption';

export { timingSafeEqual } from './timing-safe-equal';
