/**
 * The `upstreamCode` values with which `user.linkAuthProvider` and
 * `user.unlinkAuthProvider` refuse a change. The web pages map them to the
 * error codes below; a client that does not know them shows the error message.
 */
export const SIGN_IN_METHOD_CHANGE_REFUSAL_CODES = {
  /** The request did not come from a browser session. */
  browserSessionRequired: 'sign_in_method_browser_session_required',
  /** The browser session did not sign in recently, or not through the required SSO. */
  reauthRequired: 'sign_in_method_reauth_required',
  /** The account's domain requires SSO and its organization does not allow other methods. */
  ssoLinkNotAllowed: 'sign_in_method_sso_link_not_allowed',
} as const;

export type SignInMethodChangeRefusal = keyof typeof SIGN_IN_METHOD_CHANGE_REFUSAL_CODES;

/** The page error code for a change that needs a new sign-in. */
export const SIGN_IN_METHOD_REAUTH_REQUIRED_ERROR = 'SIGN-IN-METHOD-REAUTH-REQUIRED';
/** The page error code for a link that the account's SSO policy refuses. */
export const SIGN_IN_METHOD_SSO_REQUIRED_ERROR = 'SIGN-IN-METHOD-SSO-REQUIRED';

export const SIGN_IN_METHOD_CHANGE_ERROR_MESSAGES: Readonly<Record<string, string>> = {
  [SIGN_IN_METHOD_REAUTH_REQUIRED_ERROR]:
    'To change your sign-in methods, sign in again. Then make the change within 10 minutes.',
  [SIGN_IN_METHOD_SSO_REQUIRED_ERROR]:
    'Your organization requires single sign-on, so you can not link other sign-in methods.',
};

/**
 * The page error code for a refused link or unlink request, read from the
 * tRPC error's `upstreamCode`, or null when the error is not such a refusal.
 */
export function signInMethodChangeError(error: unknown): string | null {
  const data =
    typeof error === 'object' && error !== null && 'data' in error ? error.data : undefined;
  const upstreamCode =
    typeof data === 'object' && data !== null && 'upstreamCode' in data
      ? data.upstreamCode
      : undefined;
  switch (upstreamCode) {
    case SIGN_IN_METHOD_CHANGE_REFUSAL_CODES.browserSessionRequired:
    case SIGN_IN_METHOD_CHANGE_REFUSAL_CODES.reauthRequired:
      return SIGN_IN_METHOD_REAUTH_REQUIRED_ERROR;
    case SIGN_IN_METHOD_CHANGE_REFUSAL_CODES.ssoLinkNotAllowed:
      return SIGN_IN_METHOD_SSO_REQUIRED_ERROR;
    default:
      return null;
  }
}
