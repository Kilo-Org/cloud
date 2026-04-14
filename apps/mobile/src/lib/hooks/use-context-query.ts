/**
 * Resolves organization context for dual personal/org query hooks.
 *
 * - `organizationId === undefined` → unresolved, both queries disabled
 * - `organizationId === null` → personal instance
 * - `organizationId === string` → organization instance
 */
export function resolveContext(organizationId?: string | null, enabled = true) {
  const isResolved = organizationId !== undefined;
  const isOrg = Boolean(organizationId);
  return {
    isOrg,
    personalEnabled: enabled && isResolved && !isOrg,
    orgEnabled: enabled && isResolved && isOrg,
    orgInput: { organizationId: organizationId ?? '' },
  } as const;
}
