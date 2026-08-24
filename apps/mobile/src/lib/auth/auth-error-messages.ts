import { i18n } from '@/i18n';

/**
 * Server error code to catalog key. The map holds keys, never English: a code
 * that reaches the user must read in the user's language, and the copy lives
 * in one place with every other string.
 */
const AUTH_ERROR_KEYS = {
  'EMAIL-ALREADY-USED': 'authErrors.emailAlreadyUsed',
  'DIFFERENT-OAUTH': 'authErrors.differentOauth',
  SSO_ERROR: 'authErrors.ssoError',
  // Only surfaced by Apple/Google paths; the email-OTP request returns opaque 200 for blocked domains
  BLOCKED: 'authErrors.blocked',
  'SIGNUP-RATE-LIMITED': 'authErrors.signupRateLimited',
  INVALID_CODE: 'authErrors.invalidCode',
  CODE_IN_PROGRESS: 'authErrors.codeInProgress',
  TOO_MANY_ATTEMPTS: 'authErrors.tooManyAttempts',
  INVALID_TOKEN: 'authErrors.invalidToken',
  INVALID_EMAIL: 'authErrors.invalidEmail',
  INVALID_REQUEST: 'authErrors.invalidRequest',
  EMAIL_DELIVERY_FAILED: 'authErrors.emailDeliveryFailed',
  // Admission: server refuses the device under enforce mode — non-retryable.
  ADMISSION_REQUIRED: 'authErrors.admissionRequired',
} satisfies Record<string, string>;

/** The message shown when no code matched, in the active language. */
export function defaultErrorMessage(): string {
  return i18n.t('authErrors.default');
}

/** The retryable device-admission message, in the active language. */
export function retryableAdmissionError(): string {
  return i18n.t('authErrors.retryableAdmission');
}

export function mapError(errorCode: string | undefined): string {
  const key = errorCode && AUTH_ERROR_KEYS[errorCode as keyof typeof AUTH_ERROR_KEYS];
  return key ? i18n.t(key) : defaultErrorMessage();
}
