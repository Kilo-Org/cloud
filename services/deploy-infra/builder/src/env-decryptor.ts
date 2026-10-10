import { decryptWithPrivateKey, type EncryptedEnvelope } from '@kilocode/encryption';
import {
  type EncryptedEnvVar,
  type PlaintextEnvVar,
  markAsPlaintext,
} from '../../../../apps/web/src/lib/user-deployments/env-vars-validation';
import { EnvDecryptionError } from './errors';

export default function decryptEnvVars(
  envVars: EncryptedEnvVar[],
  privateKey: Buffer
): PlaintextEnvVar[] {
  if (envVars.length === 0) {
    return [];
  }

  return envVars.map(v => {
    if (!v.isSecret) {
      return markAsPlaintext({ key: v.key, value: v.value, isSecret: v.isSecret });
    }

    try {
      const envelope = JSON.parse(v.value) as EncryptedEnvelope;

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
