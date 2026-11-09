import {
  canManageOrganization,
  canManageOrganizationBilling,
  canManageOrganizationOwners,
  type OrganizationRole,
} from '@kilocode/app-shared/organizations';

/**
 * The roles the invite sheet may offer the caller, in the order it draws them.
 *
 * Mirrors the procedure's own rules (`organizations.members.invite` in
 * organization-members-router.ts): the mutation needs a billing role, an
 * elevated target needs organization-management authority, and only an owner
 * may invite an owner (`assertOwnerAuthority`). So an admin is never offered the
 * owner row, which the server would always refuse, and a billing manager is left
 * with the plain member row.
 */
export function invitableRoles(role: OrganizationRole | undefined): OrganizationRole[] {
  if (!canManageOrganizationBilling(role)) {
    return [];
  }
  if (!canManageOrganization(role)) {
    return ['member'];
  }
  const roles: OrganizationRole[] = ['member', 'billing_manager'];
  if (canManageOrganizationOwners(role)) {
    roles.push('owner');
  }
  return roles;
}

/**
 * The role the form actually submits: the selection while the caller may still
 * make it, the plain member row otherwise. A membership change underneath an
 * open form (a demotion, an account switch, a refetched organization) must not
 * leave a selection the caller can no longer assign.
 */
export function submittedInviteRole(
  role: OrganizationRole | undefined,
  selected: OrganizationRole
): OrganizationRole {
  return invitableRoles(role).some(invitable => invitable === selected) ? selected : 'member';
}
