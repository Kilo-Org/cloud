import { getEnvVariable } from '@kilocode/web-shared/lib/dotenvx';

/** Temporary kill switch: refuses new accounts via email while existing users keep email sign-in. */
export function isEmailSignupDisabled(): boolean {
  return getEnvVariable('EMAIL_SIGNUPS_DISABLED') === 'true';
}
