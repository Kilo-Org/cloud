import { canManageOrganization } from '@kilocode/app-shared/organizations';

import { useOrgBoundary } from '@/lib/hooks/use-organization-queries';

/**
 * Whether the signed-in user may create a profile in `organizationId`, and
 * whether that is already known.
 *
 * `resolving` is the state in which the membership list has not answered,
 * including the case where its read failed: `role` is absent then too, and
 * reading that absence as `read-only` would state the rule to an owner who may
 * in fact act. It is separate from `read-only` because a caller that shows
 * either an action or a statement about who may act must not claim the
 * read-only one for a user whose role it has not learned yet.
 *
 * `plan-ended` is the organization subscription gate: the membership row
 * carries the server's `isTrialExpiredForEnforcement`, which the organization
 * hub reads too. It applies only to a caller who could otherwise act, so an
 * unknown role stays `resolving` — the app must not state either refusal
 * before the role is known — and a narrow role keeps `read-only`, because that
 * is the rule its reader can act on: ask an owner. A membership row that is
 * absent leaves the plan unknown, and an unknown plan is not a lapsed one.
 */
export type OrganizationProfilePermission = 'resolving' | 'allowed' | 'read-only' | 'plan-ended';

/**
 * Resolve the profile-create permission for `organizationId`. Personal scope
 * (`organizationId === undefined`) is always manageable by the signed-in user.
 * The server rejects unauthorized writes regardless of what this reports.
 */
export function useOrganizationProfilePermission(
  organizationId?: string
): OrganizationProfilePermission {
  const { role, org, isResolving, isError } = useOrgBoundary(organizationId);
  if (organizationId === undefined) {
    return 'allowed';
  }
  if (isResolving || isError) {
    return 'resolving';
  }
  if (!canManageOrganization(role)) {
    return 'read-only';
  }
  return org?.isTrialExpiredForEnforcement === true ? 'plan-ended' : 'allowed';
}
