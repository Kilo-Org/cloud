// Canonical organization role values. Matches apps/web's
// OrganizationRoleSchema (lib/organizations/organization-types.ts, a
// z.enum(ORGANIZATION_ROLES)) and packages/db's OrganizationRole type.
export const ORGANIZATION_ROLES = ['owner', 'admin', 'member', 'billing_manager'] as const;
export type OrganizationRole = (typeof ORGANIZATION_ROLES)[number];

/**
 * Roles with organization-management authority. `admin` matches `owner`
 * everywhere except owner management, which {@link canManageOrganizationOwners}
 * reserves for owners.
 */
export const ORGANIZATION_MANAGE_ROLES = ['owner', 'admin'] satisfies OrganizationRole[];

/**
 * Roles that may manage organization billing. Admins are included because they
 * hold the same authority as owners here.
 */
export const ORGANIZATION_BILLING_ROLES = [
  'owner',
  'admin',
  'billing_manager',
] satisfies OrganizationRole[];

export function canManageOrganization(role: string | undefined): boolean {
  return ORGANIZATION_MANAGE_ROLES.some(allowed => allowed === role);
}

/**
 * Owner management — granting the owner role, or acting on an existing owner's
 * membership or pending owner invitation — is reserved for owners. Admins are
 * excluded so they can neither appoint an owner nor strip the last one.
 *
 * Mirrors `assertOwnerAuthority` in
 * apps/web/src/routers/organizations/organization-members-router.ts; keep the
 * two in sync so the UI does not offer actions the server rejects.
 */
export function canManageOrganizationOwners(role: string | undefined): boolean {
  return role === 'owner';
}

/**
 * True for roles that may manage organization billing (owner, admin or
 * billing_manager). Ported from web's `canManageBilling`
 * (components/organizations/subscription/utils.ts) and mobile's
 * `isMoneyRole` (lib/hooks/use-organization-queries.ts) — both had the
 * identical `role === 'owner' || role === 'billing_manager'` check; `admin`
 * was added because admins hold the same authority as owners.
 */
export function canManageOrganizationBilling(role: string | undefined): boolean {
  return ORGANIZATION_BILLING_ROLES.some(allowed => allowed === role);
}

// No shared role-label map: web's getRoleLabel (organization-shared-utils.tsx)
// has no billing_manager case (falls through its switch default to 'Member'),
// while mobile's ROLE_LABEL (member-row.tsx) renders 'Billing manager' for
// that role, and web's other role-label maps (InviteMemberDialog.tsx,
// MemberRoleDropdown.tsx) render 'Billing Manager' (capital M). Three
// different renderings for the same role — not shareable. owner/member
// labels agree ('Owner'/'Member' everywhere) but a partial Record<OrganizationRole, string>
// isn't a meaningful export, so nothing is shared here.
