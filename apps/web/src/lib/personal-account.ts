/**
 * Destination for users whose personal account is disabled but who have no
 * organization to fall back to. This is an unexpected state (the flag is only
 * meant for org-managed users), so the page is a terminal error rather than a
 * usable surface.
 */
export const PERSONAL_ACCOUNT_DISABLED_PATH = '/personal-account-disabled';

/**
 * Personal (non-organization) routes that stay available to users whose
 * personal account is disabled. Everything else outside a specific
 * organization is a personal surface and is blocked for those users.
 */
export const PERSONAL_ROUTE_ALLOWLIST = ['/connected-accounts', '/install', '/learn'] as const;

/**
 * Whether `pathname` targets a specific organization (e.g.
 * `/organizations/<id>` or a nested org route). The `/organizations` index and
 * the organization creation routes (`/organizations/create`,
 * `/organizations/new`) deliberately do not match: a personal-account-disabled
 * user must not reach the org list or the create-organization flow, otherwise
 * they could mint a new workspace and bypass the terminal no-workspace state.
 */
function isOrganizationScopedPath(pathname: string): boolean {
  const match = pathname.match(/^\/organizations\/([^/]+)/);
  if (!match) return false;
  const firstSegment = match[1];
  return firstSegment !== 'create' && firstSegment !== 'new';
}

/**
 * Whether `pathname` is a personal surface that a personal-account-disabled
 * user must not access directly. Specific organization routes and the
 * allowlisted personal routes are always permitted.
 */
export function isRestrictedPersonalPath(pathname: string): boolean {
  if (pathname === PERSONAL_ACCOUNT_DISABLED_PATH) return false;
  if (isOrganizationScopedPath(pathname)) return false;
  return !PERSONAL_ROUTE_ALLOWLIST.some(
    allowed => pathname === allowed || pathname.startsWith(`${allowed}/`)
  );
}
