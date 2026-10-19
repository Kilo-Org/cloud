import { canManageOrganization } from '@kilocode/app-shared/organizations';

import { useOrgBoundary } from '@/lib/hooks/use-organization-queries';

/**
 * Whether the current user holds an organization-manage role (owner/admin) in
 * `organizationId`. Personal scope (`organizationId === undefined`) is always
 * manageable by the signed-in user. Defaults to `false` while the membership
 * list loads so organization screens stay read-only until the role resolves;
 * the server rejects unauthorized writes regardless.
 */
export function useCanManageOrganizationProfiles(organizationId?: string): boolean {
  const { role } = useOrgBoundary(organizationId);
  if (organizationId === undefined) {
    return true;
  }
  return canManageOrganization(role);
}
