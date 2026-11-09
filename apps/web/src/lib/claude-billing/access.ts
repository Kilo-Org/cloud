import 'server-only';
import { TRPCError } from '@trpc/server';
import { canManageOrganization } from '@kilocode/app-shared/organizations';
import {
  getOrganizationById,
  getUserOrgMemberships,
} from '@kilocode/web-shared/lib/organizations/organizations';
import { ensureMemberOrganizationAccess } from '@kilocode/web-shared/routers/organizations/utils';

export async function canManageClaudeBillingOrganization(userId: string, organizationId: string) {
  const memberships = await getUserOrgMemberships(userId);
  if (canManageOrganization(memberships.find(entry => entry.orgId === organizationId)?.role))
    return true;
  const organization = await getOrganizationById(organizationId);
  return canManageOrganization(
    memberships.find(entry => entry.orgId === organization?.parent_organization_id)?.role
  );
}

/**
 * The person's own connection in an organization follows their access to it,
 * including access a parent organization's manager inherits, the same access
 * the organization BYOK page resolves.
 */
export async function isClaudeBillingOrganizationMember(
  userId: string,
  organizationId: string
): Promise<boolean> {
  try {
    await ensureMemberOrganizationAccess({ id: userId }, organizationId);
    return true;
  } catch (error) {
    if (error instanceof TRPCError) return false;
    throw error;
  }
}
