/**
 * Destination for users whose personal account is disabled but who have no
 * organization to fall back to. This is an unexpected state (the flag is only
 * meant for org-managed users), so the page is a terminal error rather than a
 * usable surface.
 */
export const PERSONAL_ACCOUNT_DISABLED_PATH = '/personal-account-disabled';

/**
 * Personal (non-organization) routes that stay available to users whose
 * personal account is disabled. Everything else outside `/organizations` is a
 * personal surface and is blocked for those users.
 */
export const PERSONAL_ROUTE_ALLOWLIST = ['/connected-accounts', '/install', '/learn'] as const;

/**
 * Whether `pathname` is a personal surface that a personal-account-disabled
 * user must not access directly. Organization routes and the allowlisted
 * personal routes are always permitted.
 */
export function isRestrictedPersonalPath(pathname: string): boolean {
  if (pathname.startsWith('/organizations')) return false;
  if (pathname === PERSONAL_ACCOUNT_DISABLED_PATH) return false;
  return !PERSONAL_ROUTE_ALLOWLIST.some(
    allowed => pathname === allowed || pathname.startsWith(`${allowed}/`)
  );
}
