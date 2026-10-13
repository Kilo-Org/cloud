import 'server-only';
import { getEnvVariable, requireEnv } from '@kilocode/web-shared/lib/dotenvx';

export const TURNSTILE_SECRET_KEY = requireEnv(
  'TURNSTILE_SECRET_KEY',
  getEnvVariable('TURNSTILE_SECRET_KEY')
);

export const CALLBACK_TOKEN_SECRET = requireEnv(
  'CALLBACK_TOKEN_SECRET',
  getEnvVariable('CALLBACK_TOKEN_SECRET')
);

export const GASTOWN_CF_ACCESS_CLIENT_ID = getEnvVariable('GASTOWN_SERVICE_CF_ACCESS_CLIENT_ID');
export const GASTOWN_CF_ACCESS_CLIENT_SECRET = getEnvVariable(
  'GASTOWN_SERVICE_CF_ACCESS_CLIENT_SECRET'
);

if (process.env.NODE_ENV === 'production') {
  if (!GASTOWN_CF_ACCESS_CLIENT_ID) {
    throw new Error('GASTOWN_CF_ACCESS_CLIENT_ID is required in production');
  }
  if (!GASTOWN_CF_ACCESS_CLIENT_SECRET) {
    throw new Error('GASTOWN_CF_ACCESS_CLIENT_SECRET is required in production');
  }
}

/**
 * User-deletion HMAC key. Required because the sign-in/sign-up identity
 * fence HMACs the email on every account creation and provider link, so a
 * missing value would fail authentication rather than only deletion. Fail at
 * boot instead.
 */
export const USER_DELETION_AUDIT_HMAC_KEY = requireEnv(
  'USER_DELETION_AUDIT_HMAC_KEY',
  getEnvVariable('USER_DELETION_AUDIT_HMAC_KEY')
);
/**
 * AES-256 key for user-deletion checkpoints and provider credentials.
 * Must be a base64-encoded 32-byte key.
 */
export const USER_DELETION_ENCRYPTION_KEY = requireEnv(
  'USER_DELETION_ENCRYPTION_KEY',
  getEnvVariable('USER_DELETION_ENCRYPTION_KEY')
);
