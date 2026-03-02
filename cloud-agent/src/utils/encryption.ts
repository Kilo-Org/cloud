/**
 * Encryption utilities for cloud-agent worker.
 *
 * Re-exports from @kilocode/encryption with cloud-agent-specific aliases.
 */

import type { EncryptedEnvelope } from '@kilocode/encryption';

export {
  decryptWithPrivateKey,
  decryptSecrets,
  mergeEnvVarsWithSecrets,
  encryptWithPublicKey,
  EncryptionConfigurationError,
  EncryptionFormatError,
} from '@kilocode/encryption';

export type { EncryptedEnvelope } from '@kilocode/encryption';

// Local aliases for backward compatibility
export {
  EncryptionConfigurationError as DecryptionConfigurationError,
  EncryptionFormatError as DecryptionFormatError,
} from '@kilocode/encryption';
export type { EncryptedEnvelope as EncryptedSecretEnvelope } from '@kilocode/encryption';

export type EncryptedSecrets = Record<string, EncryptedEnvelope>;
