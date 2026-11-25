/** The number of digits in the code emailed before a sign-in method change. */
export const SIGN_IN_METHOD_CHANGE_CODE_LENGTH = 6;
/** How long an account stays locked after too many wrong codes. */
export const SIGN_IN_METHOD_CHANGE_CODE_LOCKOUT_MINUTES = 15;

/**
 * The `upstreamCode` values with which `user.requestSignInMethodChangeCode`,
 * `user.linkAuthProvider` and `user.unlinkAuthProvider` refuse a request. The
 * web pages map them to the error codes below; a client that does not know
 * them shows the error message.
 */
export const SIGN_IN_METHOD_CHANGE_REFUSAL_CODES = {
  /** The request did not come from a browser session. */
  browserSessionRequired: 'sign_in_method_browser_session_required',
  /** The account's domain requires SSO and its organization does not allow other methods. */
  ssoLinkNotAllowed: 'sign_in_method_sso_link_not_allowed',
  /** The emailed code is wrong, expired, already used, or for another change. */
  codeInvalid: 'sign_in_method_code_invalid',
  /** Too many wrong codes. No new code is sent until the lockout ends. */
  codeLocked: 'sign_in_method_code_locked',
  /** A code was sent a short time ago. */
  codeCooldown: 'sign_in_method_code_cooldown',
  /** The code email could not be sent. */
  codeSendFailed: 'sign_in_method_code_send_failed',
} as const;

export type SignInMethodChangeRefusal = keyof typeof SIGN_IN_METHOD_CHANGE_REFUSAL_CODES;

/** The message for each refusal, sent with the tRPC error and shown on the pages. */
export const SIGN_IN_METHOD_CHANGE_REFUSAL_MESSAGES: Readonly<
  Record<SignInMethodChangeRefusal, string>
> = {
  browserSessionRequired:
    'To change your sign-in methods, use a browser that is signed in to app.kilo.ai.',
  ssoLinkNotAllowed:
    'Your organization requires single sign-on, so you can not link other sign-in methods.',
  codeInvalid: 'The code is not correct or it expired. Try again, or send a new code.',
  codeLocked: `Too many incorrect codes. Wait ${SIGN_IN_METHOD_CHANGE_CODE_LOCKOUT_MINUTES} minutes, then send a new code.`,
  codeCooldown: 'A code was sent a short time ago. Wait one minute before you send a new code.',
  codeSendFailed: 'We could not send the code email. Try again in a few minutes.',
};

/** The page error code for a change that did not come from a browser session. */
export const SIGN_IN_METHOD_BROWSER_SESSION_REQUIRED_ERROR =
  'SIGN-IN-METHOD-BROWSER-SESSION-REQUIRED';
/** The page error code for a link that the account's SSO policy refuses. */
export const SIGN_IN_METHOD_SSO_REQUIRED_ERROR = 'SIGN-IN-METHOD-SSO-REQUIRED';
/** The page error code for a wrong or expired code. The person can try again. */
export const SIGN_IN_METHOD_CODE_INVALID_ERROR = 'SIGN-IN-METHOD-CODE-INVALID';
/** The page error code for too many wrong codes. The person must wait. */
export const SIGN_IN_METHOD_CODE_LOCKED_ERROR = 'SIGN-IN-METHOD-CODE-LOCKED';
/** The page error code for a new code requested too soon. */
export const SIGN_IN_METHOD_CODE_COOLDOWN_ERROR = 'SIGN-IN-METHOD-CODE-COOLDOWN';
/** The page error code for a code email that could not be sent. The person can try again. */
export const SIGN_IN_METHOD_CODE_SEND_FAILED_ERROR = 'SIGN-IN-METHOD-CODE-SEND-FAILED';

export const SIGN_IN_METHOD_CHANGE_ERROR_MESSAGES: Readonly<Record<string, string>> = {
  [SIGN_IN_METHOD_BROWSER_SESSION_REQUIRED_ERROR]:
    SIGN_IN_METHOD_CHANGE_REFUSAL_MESSAGES.browserSessionRequired,
  [SIGN_IN_METHOD_SSO_REQUIRED_ERROR]: SIGN_IN_METHOD_CHANGE_REFUSAL_MESSAGES.ssoLinkNotAllowed,
  [SIGN_IN_METHOD_CODE_INVALID_ERROR]: SIGN_IN_METHOD_CHANGE_REFUSAL_MESSAGES.codeInvalid,
  [SIGN_IN_METHOD_CODE_LOCKED_ERROR]: SIGN_IN_METHOD_CHANGE_REFUSAL_MESSAGES.codeLocked,
  [SIGN_IN_METHOD_CODE_COOLDOWN_ERROR]: SIGN_IN_METHOD_CHANGE_REFUSAL_MESSAGES.codeCooldown,
  [SIGN_IN_METHOD_CODE_SEND_FAILED_ERROR]: SIGN_IN_METHOD_CHANGE_REFUSAL_MESSAGES.codeSendFailed,
};

const PAGE_ERROR_FOR_UPSTREAM_CODE: Readonly<Record<string, string>> = {
  [SIGN_IN_METHOD_CHANGE_REFUSAL_CODES.browserSessionRequired]:
    SIGN_IN_METHOD_BROWSER_SESSION_REQUIRED_ERROR,
  [SIGN_IN_METHOD_CHANGE_REFUSAL_CODES.ssoLinkNotAllowed]: SIGN_IN_METHOD_SSO_REQUIRED_ERROR,
  [SIGN_IN_METHOD_CHANGE_REFUSAL_CODES.codeInvalid]: SIGN_IN_METHOD_CODE_INVALID_ERROR,
  [SIGN_IN_METHOD_CHANGE_REFUSAL_CODES.codeLocked]: SIGN_IN_METHOD_CODE_LOCKED_ERROR,
  [SIGN_IN_METHOD_CHANGE_REFUSAL_CODES.codeCooldown]: SIGN_IN_METHOD_CODE_COOLDOWN_ERROR,
  [SIGN_IN_METHOD_CHANGE_REFUSAL_CODES.codeSendFailed]: SIGN_IN_METHOD_CODE_SEND_FAILED_ERROR,
};

/**
 * The page error code for a refused sign-in method request, read from the
 * tRPC error's `upstreamCode`, or null when the error is not such a refusal.
 */
export function signInMethodChangeError(error: unknown): string | null {
  const data =
    typeof error === 'object' && error !== null && 'data' in error ? error.data : undefined;
  const upstreamCode =
    typeof data === 'object' && data !== null && 'upstreamCode' in data
      ? data.upstreamCode
      : undefined;
  if (typeof upstreamCode !== 'string') return null;
  return PAGE_ERROR_FOR_UPSTREAM_CODE[upstreamCode] ?? null;
}
