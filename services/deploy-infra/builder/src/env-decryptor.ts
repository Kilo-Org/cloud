import { decryptWithPrivateKey, type EncryptedEnvelope } from '@kilocode/encryption';
import {
  type EncryptedEnvVar,
  type PlaintextEnvVar,
  markAsPlaintext,
} from '../../../../apps/web/src/lib/user-deployments/env-vars-validation';
import { EnvDecryptionError } from './errors';

/**
 * Decrypts secret environment variables using the provided private key.
 * Non-secret variables are returned as-is.
 *
 * @param envVars - Array of encrypted environment variables (secrets have encrypted values)
 * @param privateKey - RSA private key in PEM format for decryption
 * @returns Array of decrypted plaintext environment variables
 */
export default function decryptEnvVars(
  envVars: EncryptedEnvVar[],
  privateKey: Buffer
): PlaintextEnvVar[] {
  if (envVars.length === 0) {
    return [];
  }

  return envVars.map(v => {
    if (!v.isSecret) {
      // Non-secret values are already plaintext
      return markAsPlaintext({ key: v.key, value: v.value, isSecret: v.isSecret });
    }

    try {
      // Parse the encrypted value as JSON to get the envelope
      const envelope = JSON.parse(v.value) as EncryptedEnvelope;

      // Decrypt using the private key
      const decryptedValue = decryptWithPrivateKey(envelope, privateKey);

      return markAsPlaintext({
        key: v.key,
        value: decryptedValue,
        isSecret: v.isSecret,
      });
    } catch (error) {
      throw new EnvDecryptionError(`Failed to process secret environment variable`, v.key, error);
    }
  });
}
