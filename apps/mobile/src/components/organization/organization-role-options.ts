import {
  canManageOrganization,
  canManageOrganizationBilling,
  canManageOrganizationOwners,
  type OrganizationRole,
} from '@kilocode/app-shared/organizations';

/**
 * Which roles the caller may hand out, in the order the UI draws them.
 *
 * Both lists mirror web (`getAvailableInviteRoles` in InviteMemberDialog.tsx,
 * `getAvailableRoles` in MemberRoleDropdown.tsx) and the server's own rules in
 * organization-members-router.ts: owner management — appointing an owner, or
 * acting on an owner's membership — is reserved for owners
 * (`assertOwnerAuthority`), and an admin holds every other role.
 *
 * Only the organization role decides here. Web also lets Kilo staff
 * (`isKiloAdmin`) hand out any role; that override exists for the staff console
 * and is deliberately not mirrored in the app, which has no staff surface.
 */

/**
 * The roles the invite sheet may offer the caller. A billing manager may invite
 * only a plain member, because the invite mutation needs a billing role for a
 * plain member and organization-management authority for anything above it.
 */
export function invitableRoles(role: OrganizationRole | undefined): OrganizationRole[] {
  if (canManageOrganizationOwners(role)) {
    return ['owner', 'admin', 'member', 'billing_manager'];
  }
  if (canManageOrganization(role)) {
    return ['admin', 'member', 'billing_manager'];
  }
  if (canManageOrganizationBilling(role)) {
    return ['member'];
  }
  return [];
}

/**
 * The roles the member row offers when changing a member's role, matching the
 * web's `getAvailableRoles`. Nothing for a role that cannot change membership,
 * and no owner row for an admin, who cannot act on an owner.
 */
export function assignableMemberRoles(role: OrganizationRole | undefined): OrganizationRole[] {
  if (canManageOrganizationOwners(role)) {
    return ['owner', 'admin', 'member', 'billing_manager'];
  }
  if (canManageOrganization(role)) {
    return ['admin', 'member', 'billing_manager'];
  }
  return [];
}

/**
 * The role the invite form actually submits: the selection while the caller may
 * still make it, the plain member row otherwise. A membership change underneath
 * an open form (a demotion, an account switch, a refetched organization) must not
 * leave a selection the caller can no longer assign.
 */
export function submittedInviteRole(
  role: OrganizationRole | undefined,
  selected: OrganizationRole
): OrganizationRole {
  return invitableRoles(role).some(invitable => invitable === selected) ? selected : 'member';
}
