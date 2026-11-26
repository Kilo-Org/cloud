/**
 * The redirect of a native mobile app (RFC 8252 section 7.1): a private-use URI scheme that is the
 * reverse domain name of the app, with a single slash after the scheme. The app opens the
 * authorization request in the system browser and receives the code on this URI; PKCE and the
 * DPoP-bound code (RFC 9449 section 10) keep another app that claims the same scheme from using a
 * code it intercepts, and the sign-in hand-off asks such a client for a fresh sign-in
 * (`FRESH_SIGN_IN_SECONDS`, src/signin/handoff.ts) so a request it starts is never approved
 * without the user.
 */

/** `<reverse domain>:/<path>`, such as `com.example.app:/oauth/callback`. */
const PRIVATE_USE_REDIRECT = /^([a-z][a-z0-9]*(\.[a-z][a-z0-9]*)+):\/[a-z0-9/_-]+$/;

/** True when `uri` is a private-use-scheme redirect URI as RFC 8252 section 7.1 describes it. */
export function isPrivateUseRedirectUri(uri: string): boolean {
  return PRIVATE_USE_REDIRECT.test(uri) && !uri.includes('//');
}

/**
 * True when `redirectUri` is exactly the registered private-use redirect. The comparison is
 * exact (RFC 9700 section 2.1), so no normalization hides another target.
 */
export function matchesPrivateUseRedirect(registered: string, redirectUri: string): boolean {
  return isPrivateUseRedirectUri(registered) && redirectUri === registered;
}
