import { canManageOrganization } from '@kilocode/app-shared/organizations';

import { useOrgBoundary } from '@/lib/hooks/use-organization-queries';

/**
 * Whether the signed-in user may create a profile in `organizationId`, and
 * whether that is already known.
 *
 * `resolving` is the state before the membership list answers. It is separate
 * from `read-only` because a caller that shows either an action or a statement
 * about who may act must not claim the read-only one for a user whose role it
 * has not learned yet.
 */
export type OrganizationProfilePermission = 'resolving' | 'allowed' | 'read-only';

/**
 * Resolve the profile-create permission for `organizationId`. Personal scope
 * (`organizationId === undefined`) is always manageable by the signed-in user.
 * The server rejects unauthorized writes regardless of what this reports.
 */
export function useOrganizationProfilePermission(
  organizationId?: string
): OrganizationProfilePermission {
  const { role, isResolving } = useOrgBoundary(organizationId);
  if (organizationId === undefined) {
    return 'allowed';
  }
  if (isResolving) {
    return 'resolving';
  }
  return canManageOrganization(role) ? 'allowed' : 'read-only';
}

/**
 * Whether the current user holds an organization-manage role (owner/admin) in
 * `organizationId`. Defaults to `false` while the membership list loads so
 * organization screens stay read-only until the role resolves; the server
 * rejects unauthorized writes regardless.
 */
export function useCanManageOrganizationProfiles(organizationId?: string): boolean {
  return useOrganizationProfilePermission(organizationId) === 'allowed';
}
