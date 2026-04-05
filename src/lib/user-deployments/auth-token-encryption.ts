import { USER_DEPLOYMENTS_GIT_TOKEN_ENCRYPTION_KEY } from '@/lib/config.server';
import {
  encryptWithSymmetricKey,
  decryptWithSymmetricKey,
  EncryptionConfigurationError,
} from '@/lib/encryption';

/**
 * Encrypt an auth token for storage
 */
export function encryptAuthToken(token: string): string {
  if (!USER_DEPLOYMENTS_GIT_TOKEN_ENCRYPTION_KEY) {
    throw new EncryptionConfigurationError(
      'USER_DEPLOYMENTS_GIT_TOKEN_ENCRYPTION_KEY not configured'
    );
  }
  return encryptWithSymmetricKey(token, USER_DEPLOYMENTS_GIT_TOKEN_ENCRYPTION_KEY);
}

/**
 * Decrypt an auth token from storage
 */
export function decryptAuthToken(encryptedToken: string): string {
  if (!USER_DEPLOYMENTS_GIT_TOKEN_ENCRYPTION_KEY) {
    throw new EncryptionConfigurationError(
      'USER_DEPLOYMENTS_GIT_TOKEN_ENCRYPTION_KEY not configured'
    );
  }
  return decryptWithSymmetricKey(encryptedToken, USER_DEPLOYMENTS_GIT_TOKEN_ENCRYPTION_KEY);
}
