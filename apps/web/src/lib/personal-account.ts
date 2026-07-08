/**
 * Destination for users whose personal account is disabled but who have no
 * organization to fall back to. This is an unexpected state (the flag is only
 * meant for org-managed users), so the page is a terminal error rather than a
 * usable surface.
 */
export const PERSONAL_ACCOUNT_DISABLED_PATH = '/personal-account-disabled';
