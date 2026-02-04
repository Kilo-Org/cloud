/**
 * Encryption utilities for cloud-agent worker.
 *
 * This module re-exports decryption functions from the shared kilocode-backend
 * encryption module and provides cloud-agent-specific helper functions.
 *
 * The encryption format uses RSA+AES envelope encryption:
 * - DEK (Data Encryption Key) is encrypted with RSA-OAEP using SHA-256
 * - Data is encrypted with AES-256-GCM using the DEK
 * - Format: { encryptedData, encryptedDEK, algorithm: 'rsa-aes-256-gcm', version: 1 }
 */

import {
  decryptWithPrivateKey,
  EncryptionConfigurationError,
  EncryptionFormatError,
  type EncryptedEnvelope,
} from '../../../src/lib/encryption.js';

// Re-export with cloud-agent-specific names for API clarity
export {
  decryptWithPrivateKey,
  EncryptionConfigurationError as DecryptionConfigurationError,
  EncryptionFormatError as DecryptionFormatError,
};

// Re-export the type with our naming
export type { EncryptedEnvelope as EncryptedSecretEnvelope };

/**
 * Type alias for a map of encrypted secrets (key name -> encrypted envelope).
 */
export type EncryptedSecrets = Record<string, EncryptedEnvelope>;

/**
 * Decrypt all encrypted secrets and return them as a plain Record<string, string>.
 *
 * @param encryptedSecrets - Map of key names to encrypted envelopes
 * @param privateKeyPem - RSA private key in PEM format
 * @returns Map of key names to decrypted plaintext values
 * @throws EncryptionConfigurationError if private key is invalid
 * @throws EncryptionFormatError if any envelope structure is invalid
 */
export function decryptSecrets(
  encryptedSecrets: EncryptedSecrets,
  privateKeyPem: string | Buffer
): Record<string, string> {
  const result: Record<string, string> = {};

  for (const [key, envelope] of Object.entries(encryptedSecrets)) {
    result[key] = decryptWithPrivateKey(envelope, privateKeyPem);
  }

  return result;
}

/**
 * Merge plaintext env vars with decrypted secrets.
 * Decrypted secrets override plaintext env vars if there are conflicts.
 *
 * @param envVars - Plaintext environment variables (optional)
 * @param encryptedSecrets - Encrypted secrets to decrypt (optional)
 * @param privateKeyPem - RSA private key for decryption (required if encryptedSecrets provided)
 * @returns Merged environment variables with decrypted secrets
 */
export function mergeEnvVarsWithSecrets(
  envVars: Record<string, string> | undefined,
  encryptedSecrets: EncryptedSecrets | undefined,
  privateKeyPem: string | Buffer | undefined
): Record<string, string> {
  const result: Record<string, string> = { ...(envVars || {}) };

  if (encryptedSecrets && Object.keys(encryptedSecrets).length > 0) {
    if (!privateKeyPem) {
      throw new EncryptionConfigurationError(
        'AGENT_ENV_VARS_PRIVATE_KEY is required to decrypt encrypted secrets'
      );
    }

    const decrypted = decryptSecrets(encryptedSecrets, privateKeyPem);

    // Secrets override env vars (as per plan spec)
    for (const [key, value] of Object.entries(decrypted)) {
      result[key] = value;
    }
  }

  return result;
}
