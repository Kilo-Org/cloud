import 'server-only';

import { db } from '@/lib/drizzle';
import type { ProfileOrganization } from '@/lib/organizations/organizations';
import { verifiedDomainEmailIdentity } from '@/lib/organizations/verified-domain';
import { organization_domain_claims, type Organization, type User } from '@kilocode/db/schema';
import { and, eq } from 'drizzle-orm';

export async function resolvePreferredVerifiedDomainOrganizationId(
  user: Pick<User, 'google_user_email' | 'normalized_email'>,
  permittedOrganizations: readonly ProfileOrganization[]
): Promise<Organization['id'] | null> {
  if (permittedOrganizations.length === 0) return null;
  const identity = verifiedDomainEmailIdentity(user);
  if (!identity) return null;

  const claims = await db
    .select({ organizationId: organization_domain_claims.organization_id })
    .from(organization_domain_claims)
    .where(
      and(
        eq(organization_domain_claims.domain, identity.domain),
        eq(organization_domain_claims.status, 'verified')
      )
    )
    .limit(2);
  if (claims.length !== 1) return null;

  const organizationId = claims[0].organizationId;
  return permittedOrganizations.some(organization => organization.id === organizationId)
    ? organizationId
    : null;
}
