// Canonical organization role values. Matches apps/web's
// OrganizationRoleSchema (lib/organizations/organization-types.ts, a
// z.enum(ORGANIZATION_ROLES)) and packages/db's OrganizationRole type.
// Mobile's local string-union copies (e.g. lib/security-agent.ts) do not yet
// include 'admin'; mobile support for the admin role is tracked separately.
export const ORGANIZATION_ROLES = ['owner', 'admin', 'member', 'billing_manager'] as const;
export type OrganizationRole = (typeof ORGANIZATION_ROLES)[number];

/**
 * Roles with full organization-management authority. `admin` is an exact peer
 * of `owner`: there is no action an owner can take that an admin cannot.
 */
export const ORGANIZATION_MANAGE_ROLES = ['owner', 'admin'] satisfies OrganizationRole[];

/**
 * Roles that may manage organization billing. Admins are included because they
 * hold the same authority as owners.
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
