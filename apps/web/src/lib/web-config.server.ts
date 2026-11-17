import 'server-only';
import { getEnvVariable, requireEnv } from '@kilocode/web-shared/lib/dotenvx';

export const SESSION_SYNC_WORKER_URL =
  getEnvVariable('SESSION_SYNC_WORKER_URL') ||
  (process.env.VERCEL_ENV === 'production' &&
  (!process.env.VERCEL_TARGET_ENV || process.env.VERCEL_TARGET_ENV === 'production')
    ? 'https://session-sync.kiloapps.io'
    : '');

export const TURNSTILE_SECRET_KEY = requireEnv(
  'TURNSTILE_SECRET_KEY',
  getEnvVariable('TURNSTILE_SECRET_KEY')
);

export const CALLBACK_TOKEN_SECRET = requireEnv(
  'CALLBACK_TOKEN_SECRET',
  getEnvVariable('CALLBACK_TOKEN_SECRET')
);

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
