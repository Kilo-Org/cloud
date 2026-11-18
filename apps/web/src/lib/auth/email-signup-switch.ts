import { getEnvVariable } from '@kilocode/web-shared/lib/dotenvx';

/**
 * New accounts via email are refused unless EMAIL_SIGNUPS_ENABLED is exactly `true`.
 * Existing users keep email sign-in either way.
 */
export function isEmailSignupDisabled(): boolean {
  return getEnvVariable('EMAIL_SIGNUPS_ENABLED') !== 'true';
}
