export type AuthErrorType =
  | 'BLOCKED'
  | 'DIFFERENT-OAUTH'
  | 'ACCOUNT-ALREADY-LINKED'
  | 'PROVIDER-ALREADY-LINKED'
  | 'LINKING-FAILED'
  | 'USER-NOT-FOUND'
  | 'UNKNOWN-ERROR'
  | 'TURNSTILE_REQUIRED'
  | 'SYSTEM_ERROR'
  | 'INVALID_VERIFICATION'
  | 'IP_MISMATCH'
  | 'SIGNUP-RATE-LIMITED'
  | 'SIGNUP-STEP-UP'
  | 'SIGNUP-UNAVAILABLE'
  | 'EMAIL-ALREADY-USED'
  | 'ADMISSION_REQUIRED'
  | 'SSO_ERROR';

/**
 * The sign-in methods a signup step-up can ask for, in display order. Bouncer may list other
 * methods; Cloud shows only these.
 */
export const SIGNUP_STEP_UP_METHODS = ['google', 'apple'] as const;
export type SignupStepUpMethod = (typeof SIGNUP_STEP_UP_METHODS)[number];

/** The known step-up methods among `values`, in display order and without duplicates. */
export function knownSignupStepUpMethods(values: Iterable<string>): SignupStepUpMethod[] {
  const present = new Set(values);
  return SIGNUP_STEP_UP_METHODS.filter(method => present.has(method));
}

export const hosted_domain_specials = {
  non_workspace_google_account: '@@personal@@',
  anaconda: '@@anaconda@@',
  apple: '@@apple@@',
  github: '@@github@@',
  gitlab: '@@gitlab@@',
  linkedin: '@@linkedin@@',
  discord: '@@discord@@',
  openai: '@@openai@@',
  email: '@@email@@',
  fake_devonly: '@@fake@@',
  kilocode_admin: 'kilocode.ai',
} as const;

// Development organization constants (only used in dev mode)
// Uses hosted_domain_specials.kilocode_admin as the SSO domain
// Note: Must be a valid UUID format (Zod validation requires specific bit patterns)
// Using all zeros UUID which is explicitly allowed by Zod's UUID validator
export const DEV_ORG_ID = '00000000-0000-0000-0000-000000000000';
export const DEV_ORG_NAME = 'Kilocode Local';
export const SSO_SIGNIN_PATH = '/users/sign_in';
