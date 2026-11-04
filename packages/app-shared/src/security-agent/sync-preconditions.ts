/**
 * Stable wire codes for the Security Agent preconditions.
 *
 * The server rejects a manual sync, or enabling the agent, with
 * `PRECONDITION_FAILED` when the Security Agent cannot run: no repository in
 * scope, a missing or inactive GitHub integration, or an installation without
 * the `vulnerability_alerts` permission. The English message each rejection
 * carries is the web surface's copy; a device that has to translate it cannot
 * match on that sentence. The rejection's cause is an `UpstreamApiError`, which
 * the tRPC error formatter exposes to every client as `data.upstreamCode`, so
 * the mobile ledger maps this code onto catalog copy instead.
 */
export const SECURITY_SYNC_PRECONDITION_CODES = {
  noRepositories: 'security_sync_no_repositories',
  integrationInactive: 'security_sync_integration_inactive',
  missingPermission: 'security_sync_missing_permission',
} as const;

export type SecuritySyncPrecondition = keyof typeof SECURITY_SYNC_PRECONDITION_CODES;

export type SecuritySyncPreconditionCode =
  (typeof SECURITY_SYNC_PRECONDITION_CODES)[SecuritySyncPrecondition];

// Derived by inverting SECURITY_SYNC_PRECONDITION_CODES: a code added to that
// object is mapped here too, so it cannot resolve to null. A Map, not an
// object literal: an inherited `Object.prototype` name such as `constructor`
// must read as "no precondition", not as a function.
const PRECONDITION_BY_CODE = new Map<string, SecuritySyncPrecondition>(
  Object.entries(SECURITY_SYNC_PRECONDITION_CODES).map(
    ([precondition, code]): [string, SecuritySyncPrecondition] => [
      code,
      // Object.entries widens the const object's keys to `string`; its keys
      // are exactly the precondition names.
      precondition as SecuritySyncPrecondition,
    ]
  )
);

/** The sync precondition an upstream code names, or null for any other code. */
export function securitySyncPreconditionForCode(
  code: string | undefined
): SecuritySyncPrecondition | null {
  if (code === undefined) {
    return null;
  }
  return PRECONDITION_BY_CODE.get(code) ?? null;
}
