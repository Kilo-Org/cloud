export const AUTH_ERROR_MESSAGES: Record<string, string> = {
  'EMAIL-ALREADY-USED':
    "An account with this email already exists with a different sign-in method. Try another method or use 'More sign-in options'.",
  'DIFFERENT-OAUTH':
    "An account with this email already exists with a different sign-in method. Try another method or use 'More sign-in options'.",
  SSO_ERROR: "Your organization requires SSO. Use 'More sign-in options'.",
  // Only surfaced by Apple/Google paths; the email-OTP request returns opaque 200 for blocked domains
  BLOCKED: 'This account has been blocked. Please contact support.',
  'SIGNUP-RATE-LIMITED': 'Too many attempts. Please try again later.',
  INVALID_CODE: 'That code is incorrect. Please try again.',
  CODE_IN_PROGRESS: 'Your code is being processed. Wait a moment and try again.',
  TOO_MANY_ATTEMPTS: 'Too many attempts. Please request a new code.',
  INVALID_TOKEN: 'Sign-in failed. Please try again.',
  INVALID_EMAIL: 'Unable to deliver email to this address. Please use a different email.',
  INVALID_REQUEST: 'Check your email address and try again.',
  EMAIL_DELIVERY_FAILED: 'Email delivery is temporarily unavailable. Please try again later.',
  // Admission: server refuses the device under enforce mode — non-retryable.
  ADMISSION_REQUIRED:
    "Your device can't be verified. Use 'More sign-in options' to sign in on another device or through the web.",
};

export const DEFAULT_ERROR_MESSAGE = 'Something went wrong. Please try again.';
export const RETRYABLE_ADMISSION_ERROR =
  'We could not verify this device. Check your connection and try again.';

export function mapError(errorCode: string | undefined): string {
  return (errorCode && AUTH_ERROR_MESSAGES[errorCode]) ?? DEFAULT_ERROR_MESSAGE;
}
