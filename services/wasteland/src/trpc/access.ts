/**
 * The one access rule for a wasteland.
 *
 * Two call sites need it and they must never disagree: the address
 * resolver filters a slug's claimants by what the caller can reach
 * (`resolve-wasteland.ts`), and every UUID-keyed procedure is gated by
 * `resolveWastelandOwnership` (`ownership.ts`). The rule therefore lives
 * here once, as a decision the resolver reads as a boolean and the
 * ownership check maps onto its error codes.
 *
 * This module imports nothing, so Node-pool unit tests can load it
 * without the `cloudflare:workers` dependency of the DO helpers.
 */

/** Who is asking, in the shape both call sites already have. */
export type WastelandViewer = {
  userId: string;
  isAdmin: boolean;
  orgMemberships: ReadonlyArray<{ orgId: string; role: string }>;
};

/** The ownership columns a wasteland carries. */
export type WastelandOwnerFields = {
  owner_type: 'user' | 'org';
  owner_user_id: string | null;
  organization_id: string | null;
};

/**
 * `admin` is what an admin gets for a wasteland they do not own; `denied`
 * carries which surface answer applies, `forbidden` for a wasteland that
 * exists but is not the caller's and `not_found` for one whose ownership
 * cannot be established at all.
 */
export type WastelandAccess =
  | { type: 'user'; userId: string }
  | { type: 'org'; orgId: string }
  | { type: 'admin' }
  | { type: 'denied'; reason: 'forbidden' | 'not_found' };

export function resolveWastelandAccess(
  wasteland: WastelandOwnerFields,
  viewer: WastelandViewer
): WastelandAccess {
  if (wasteland.owner_type === 'user') {
    if (wasteland.owner_user_id === viewer.userId) {
      return { type: 'user', userId: viewer.userId };
    }
    return viewer.isAdmin ? { type: 'admin' } : { type: 'denied', reason: 'forbidden' };
  }

  if (wasteland.owner_type === 'org' && wasteland.organization_id) {
    const organizationId = wasteland.organization_id;
    const membership = viewer.orgMemberships.find(m => m.orgId === organizationId);
    if (membership && membership.role !== 'billing_manager') {
      return { type: 'org', orgId: organizationId };
    }
    return viewer.isAdmin ? { type: 'admin' } : { type: 'denied', reason: 'forbidden' };
  }

  return viewer.isAdmin ? { type: 'admin' } : { type: 'denied', reason: 'not_found' };
}

/** Boolean form of the same decision, for filtering candidate rows. */
export function canAccessWasteland(
  wasteland: WastelandOwnerFields,
  viewer: WastelandViewer
): boolean {
  return resolveWastelandAccess(wasteland, viewer).type !== 'denied';
}
