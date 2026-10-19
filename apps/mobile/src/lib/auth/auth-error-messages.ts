import { i18n } from '@/i18n';
import type en from '@/i18n/locales/en.json';

/** `Object.hasOwn` under a short name so the map lookup stays one line. */
const hasOwn = Object.hasOwn;

/**
 * Every catalog key a translated-at-render auth error may carry. Derived from
 * the English catalog's `authErrors` section, so a typo or a key the catalog
 * dropped is a compile error instead of a raw key rendered to the user.
 */
type AuthErrorsSection = (typeof en)['authErrors'];
export type AuthErrorMessageKey = `authErrors.${keyof AuthErrorsSection & string}`;

/**
 * Server error code to catalog key. The map holds keys, never English: a code
 * that reaches the user must read in the user's language, and the copy lives
 * in one place with every other string.
 */
const AUTH_ERROR_KEYS = {
  'EMAIL-ALREADY-USED': 'authErrors.differentOauth',
  'DIFFERENT-OAUTH': 'authErrors.differentOauth',
  SSO_ERROR: 'authErrors.ssoError',
  // Only surfaced by Apple/Google paths; the email-OTP request returns opaque 200 for blocked domains
  BLOCKED: 'authErrors.blocked',
  'SIGNUP-RATE-LIMITED': 'authErrors.signupRateLimited',
  // Without the methods or a matching button, the browser sign-in offers Google and Apple.
  'SIGNUP-STEP-UP': 'authErrors.signupStepUp',
  INVALID_CODE: 'authErrors.invalidCode',
  CODE_IN_PROGRESS: 'authErrors.codeInProgress',
  TOO_MANY_ATTEMPTS: 'authErrors.tooManyAttempts',
  INVALID_TOKEN: 'authErrors.invalidToken',
  INVALID_EMAIL: 'authErrors.invalidEmail',
  INVALID_REQUEST: 'authErrors.invalidRequest',
  EMAIL_DELIVERY_FAILED: 'authErrors.emailDeliveryFailed',
  // Client-side: the bounded auth POST aborted before the server answered.
  TIMEOUT: 'authErrors.signInTimedOut',
  // Admission: server refuses the device under enforce mode — non-retryable.
  ADMISSION_REQUIRED: 'authErrors.admissionRequired',
} satisfies Record<string, AuthErrorMessageKey>;

/** The message shown when no code matched, in the active language. */
export function defaultErrorMessage(): string {
  return i18n.t('authErrors.default');
}

/** The retryable device-admission message, in the active language. */
export function retryableAdmissionError(): string {
  return i18n.t('authErrors.retryableAdmission');
}

/**
 * Server error code to catalog key, untranslated. Render-time translation (an
 * inline field error or a banner that survives a language switch) must call
 * `t` on this key when it renders, not store `mapError`'s output — an already
 * translated string freezes the language it was mapped in.
 */
export function mapErrorKey(errorCode: string | undefined): AuthErrorMessageKey {
  if (!errorCode) {
    return 'authErrors.default';
  }
  return hasOwn(AUTH_ERROR_KEYS, errorCode)
    ? AUTH_ERROR_KEYS[errorCode as keyof typeof AUTH_ERROR_KEYS]
    : 'authErrors.default';
}

export function mapError(errorCode: string | undefined): string {
  return i18n.t(mapErrorKey(errorCode));
}

/**
 * The `SIGNUP-STEP-UP` message. It names an allowed Apple or Google button only when that button
 * is on this sign-in screen; otherwise it points to the browser sign-in options.
 */
export function signupStepUpMessage(
  methods: readonly string[] | undefined,
  shown: { apple: boolean; google: boolean }
): string {
  if (shown.apple && methods?.includes('apple')) {
    return i18n.t('authErrors.signupStepUpApple');
  }
  if (shown.google && methods?.includes('google')) {
    return i18n.t('authErrors.signupStepUpGoogle');
  }
  return i18n.t('authErrors.signupStepUp');
}
