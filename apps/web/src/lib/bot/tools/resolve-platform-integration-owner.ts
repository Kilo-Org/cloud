/**
 * Discriminated owner reference for a platform integration.
 * The schema enforces XOR ownership, so exactly one of
 * `owned_by_organization_id` / `owned_by_user_id` is non-null.
 */
export type OwnerRef = { kind: 'org'; id: string } | { kind: 'user'; id: string };

type PlatformIntegrationOwnerColumns = {
  owned_by_organization_id: string | null;
  owned_by_user_id: string | null;
};

/**
 * Narrow a platform integration row's XOR ownership into a discriminated
 * `OwnerRef`. Throws if the row has neither an organization nor a user owner
 * (defensive guard for malformed rows; the DB schema enforces XOR).
 */
export function resolvePlatformIntegrationOwner(
  platformIntegration: PlatformIntegrationOwnerColumns
): OwnerRef {
  if (platformIntegration.owned_by_organization_id) {
    return { kind: 'org', id: platformIntegration.owned_by_organization_id };
  }
  if (platformIntegration.owned_by_user_id) {
    return { kind: 'user', id: platformIntegration.owned_by_user_id };
  }
  throw new Error('Platform integration has no owner (both organization and user are null).');
}
