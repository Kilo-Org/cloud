import type { User, user_auth_provider } from '@kilocode/db/schema';
import {
  getDeliveredEmailAddress,
  getLowerDomainFromEmail,
} from '@kilocode/web-shared/lib/email-address';
import { resolveSsoAuthorityForDomain } from '@kilocode/web-shared/lib/organizations/organization-sso-policy';
import { getUserOrgMemberships } from '@kilocode/web-shared/lib/organizations/organizations';
import { getDnsVerifiedDomainsByExternalId } from '@/lib/scim/directory-verified-domains';

/**
 * Whether a company SSO sign-in proved the account's primary address.
 *
 * Two writers store `workos` rows, and only one of them proves an address:
 * - An SSO sign-in (`processSSOInternal`) writes the WorkOS profile id and sets
 *   `hosted_domain` to the address's domain. It runs only after the domain maps
 *   to exactly one WorkOS organization, that organization is linked to a Kilo
 *   organization, and that Kilo organization is the domain's SSO authority.
 * - Directory sync (`upsertDirectoryUser`) writes the directory user id with a
 *   null `hosted_domain`. Its address is the identity provider's assertion,
 *   not a sign-in, so its rows prove nothing on their own.
 *
 * So the proof is a `workos` row for the primary address whose `hosted_domain`
 * is the primary address's domain, with the sign-in's authority still in force
 * now: the domain requires SSO, the account is a member of the organization
 * that is its authority, and the WorkOS organization whose `externalId` is
 * that organization's id has verified the domain through DNS. That is the same
 * link the sign-in checks. A domain whose SSO was turned off, moved to
 * another organization, or left misconfigured proves nothing, and neither does
 * an account that has left the authority organization.
 *
 * DNS verification is required because neither the authority nor the sign-in
 * shows the organization controls the domain: an owner can set any unclaimed
 * domain as `sso_domain`, and WorkOS lists a domain attached to an
 * organization before it is verified. DNS verification
 * (`dnsVerifiedDomains`) is the repository's bar for domain control. No linked
 * WorkOS organization, or a lookup that fails for any reason, answers false,
 * so the exchange succeeds without the address and the next exchange asks
 * again.
 *
 * Directory sync can move an SSO row's address within the same domain
 * (`applyDirectoryUserChanges`), keeping its profile id and `hosted_domain`.
 * Such an address counts: the row cannot be told apart from one a sign-in
 * wrote, and the authority and membership checks still hold. A move to a
 * different domain leaves `hosted_domain` on the old one, so it does not count.
 *
 * The address comparison ignores case only, as `hasVerifiedPrimaryAddress`
 * does. The database is read only when a matching row exists, and WorkOS only
 * when every other condition holds.
 */
export async function hasSsoVerifiedPrimaryAddress(
  user: Pick<User, 'id' | 'google_user_email'>,
  providers: readonly Pick<
    typeof user_auth_provider.$inferSelect,
    'provider' | 'email' | 'hosted_domain'
  >[]
): Promise<boolean> {
  const primary = getDeliveredEmailAddress(user.google_user_email);
  const domain = getLowerDomainFromEmail(primary);
  if (!domain) return false;

  const signedInThroughSso = providers.some(
    p =>
      p.provider === 'workos' &&
      p.hosted_domain?.toLowerCase() === domain &&
      getDeliveredEmailAddress(p.email) === primary
  );
  if (!signedInThroughSso) return false;

  const authority = await resolveSsoAuthorityForDomain(domain);
  if (authority.status !== 'required') return false;

  const memberships = await getUserOrgMemberships(user.id);
  if (!memberships.some(m => m.orgId === authority.sourceOrganizationId)) return false;

  return await authorityDnsVerifiedDomain(authority.sourceOrganizationId, domain);
}

async function authorityDnsVerifiedDomain(
  organizationId: string,
  domain: string
): Promise<boolean> {
  try {
    const verified = await getDnsVerifiedDomainsByExternalId(organizationId);
    return verified?.includes(domain) ?? false;
  } catch (error) {
    console.warn('[pages-auth] Could not read the SSO authority verified domains', {
      organizationId,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}
