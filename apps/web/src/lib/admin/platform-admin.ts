import 'server-only';

import { hosted_domain_specials } from '@/lib/auth/constants';

export const platformAdminDomains = [
  hosted_domain_specials.kilocode_admin,
  'anaconda.com',
] as const;

/**
 * Exact eligibility rule for Kilo production platform-admin domains.
 *
 * This intentionally preserves current case-sensitive behavior: the hosted
 * domain must equal an allowed corporate domain exactly and the email must
 * end with that same domain exactly. It does not broaden matching to uppercase
 * variants, subdomains, or registrable parent domains.
 *
 * Used both to gate the production auto-provisioning rule (historically)
 * and, going forward, to gate manual grant/revoke eligibility and candidate
 * search for the `/admin/admins` page. Search filtering is not a security
 * boundary — callers performing a grant must re-check this themselves
 * against freshly loaded rows.
 */
export function isEligibleForPlatformAdmin(email: string, hostedDomain: string | null): boolean {
  return platformAdminDomains.some(
    domain => hostedDomain === domain && email.endsWith(`@${domain}`)
  );
}

/**
 * Fake-login-only automatic admin bootstrap rule for ephemeral development
 * and staging environments. Production auto-provisioning was removed; new
 * production users always start as non-admin and must be granted access
 * explicitly through `/admin/admins`.
 */
export function shouldAutoProvisionPlatformAdmin(
  email: string,
  hostedDomain: string | null,
  fakeLoginEnabled: boolean
): boolean {
  return (
    fakeLoginEnabled &&
    hostedDomain === hosted_domain_specials.fake_devonly &&
    email.endsWith('@admin.example.com')
  );
}
