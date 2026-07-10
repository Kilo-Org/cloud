// Canonical organization role values. Matches apps/web's
// OrganizationRoleSchema (lib/organizations/organization-types.ts, a
// z.enum(['owner', 'member', 'billing_manager'])) and packages/db's
// OrganizationRole type ('owner' | 'member' | 'billing_manager') — verified
// identical while porting. Mobile's local string-union copies (e.g.
// lib/security-agent.ts) also match, just declared in a different member
// order (order doesn't affect the union type).
export const ORGANIZATION_ROLES = ['owner', 'member', 'billing_manager'] as const;
export type OrganizationRole = (typeof ORGANIZATION_ROLES)[number];

/**
 * True for roles that may manage organization billing (owner or
 * billing_manager). Ported from web's `canManageBilling`
 * (components/organizations/subscription/utils.ts) and mobile's
 * `isMoneyRole` (lib/hooks/use-organization-queries.ts) — both had the
 * identical `role === 'owner' || role === 'billing_manager'` check.
 */
export function canManageOrganizationBilling(role: string | undefined): boolean {
  return role === 'owner' || role === 'billing_manager';
}

// No shared role-label map: web's getRoleLabel (organization-shared-utils.tsx)
// has no billing_manager case (falls through its switch default to 'Member'),
// while mobile's ROLE_LABEL (member-row.tsx) renders 'Billing manager' for
// that role, and web's other role-label maps (InviteMemberDialog.tsx,
// MemberRoleDropdown.tsx) render 'Billing Manager' (capital M). Three
// different renderings for the same role — not shareable. owner/member
// labels agree ('Owner'/'Member' everywhere) but a partial Record<OrganizationRole, string>
// isn't a meaningful export, so nothing is shared here.
