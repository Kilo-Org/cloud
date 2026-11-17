import 'server-only';
import { canManageOrganization } from '@kilocode/app-shared/organizations';
import {
  getOrganizationById,
  getUserOrgMemberships,
} from '@kilocode/web-shared/lib/organizations/organizations';

export async function canManageClaudeBillingOrganization(userId: string, organizationId: string) {
  const memberships = await getUserOrgMemberships(userId);
  if (canManageOrganization(memberships.find(entry => entry.orgId === organizationId)?.role))
    return true;
  const organization = await getOrganizationById(organizationId);
  return canManageOrganization(
    memberships.find(entry => entry.orgId === organization?.parent_organization_id)?.role
  );
}
