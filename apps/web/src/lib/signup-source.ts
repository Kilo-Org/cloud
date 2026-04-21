/**
 * Shared parsing for the callback paths that attribute a signup to a
 * specific product. Used by both the account-verification page (which
 * grants product-specific signup bonuses based on the source) and the
 * after-sign-in analytics route (which tags the signup_product_attributed
 * PostHog event).
 *
 * Centralized so bonus-attribution logic and analytics-attribution logic
 * can't drift. A new product attribution should be added in one place.
 *
 * Matching uses an exact pathname check rather than a prefix check.
 * A naive `callbackPath.startsWith('/openclaw-advisor')` would also
 * match `/openclaw-advisor-fake`, `/openclaw-advisory`, or any sibling
 * path that happens to share the prefix. Exact matching requires the
 * pathname to terminate after `/openclaw-advisor` with one of: end-of-
 * string, `/`, `?`, or `#`.
 *
 * For the OpenClaw Security Advisor attribution we also require a valid
 * `code` query parameter in the callback path. That's the authoritative
 * signal that the user arrived through the real plugin device-auth flow
 * rather than having had `callbackPath=/openclaw-advisor` injected by
 * visiting the sign-in URL directly. Without this check, a bare
 * `/openclaw-advisor` callback would qualify for the signup bonus even
 * when no plugin ever issued a device-auth code.
 */

/**
 * Matches exactly the `/openclaw-advisor` pathname, optionally followed
 * by a trailing slash, query string, or fragment. Intentionally not
 * exported: callers should use `isOpenclawAdvisorCallback`, which also
 * gates on a valid device-auth code. Exposing the pathname regex on its
 * own would invite callers to skip the code check.
 */
const OPENCLAW_ADVISOR_PATH_RE = /^\/openclaw-advisor(?:[/?#]|$)/;

/**
 * Device-auth code shape: unambiguous alphanumeric with optional dashes,
 * 1 to 16 chars. Exported so `apps/web/src/app/openclaw-advisor/page.tsx`
 * (which also validates the raw `?code=` query param before kicking off
 * the auth redirect) can consume the single source of truth instead of
 * carrying its own copy.
 */
export const DEVICE_AUTH_CODE_FORMAT = /^[A-Za-z0-9-]{1,16}$/;

/**
 * True when the callback path attributes the signup to the OpenClaw
 * Security Advisor plugin: pathname exact-matches `/openclaw-advisor`
 * AND the path carries a `code` query parameter matching the device-auth
 * code format. The `code` requirement is the real-plugin-flow gate;
 * without it, a manually-constructed callbackPath could award the
 * product-specific signup bonus without the user ever completing a
 * device-auth session.
 *
 * Parses the callback path as if it were relative to an arbitrary
 * origin so query-string extraction uses the standard URL API. Returns
 * false on any parse failure.
 */
export function isOpenclawAdvisorCallback(callbackPath: string | null | undefined): boolean {
  if (typeof callbackPath !== 'string' || callbackPath.length === 0) return false;
  if (!OPENCLAW_ADVISOR_PATH_RE.test(callbackPath)) return false;

  let url: URL;
  try {
    url = new URL(callbackPath, 'https://placeholder.invalid');
  } catch {
    return false;
  }

  const code = url.searchParams.get('code');
  if (code === null) return false;
  return DEVICE_AUTH_CODE_FORMAT.test(code);
}
