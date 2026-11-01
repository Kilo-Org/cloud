/**
 * Resolve an `<owner>/<repo>` address to the wasteland that owns that
 * upstream slug. Used by both the `wasteland.resolveOwnerRepo` tRPC
 * procedure and any internal handler that needs to translate a
 * route-style address into a `wastelandId` before invoking a
 * UUID-keyed procedure.
 *
 * A slug can have several claimants: `docs/admin-mode.md` documents
 * wastelands that point at an upstream their creator does not own, and
 * the same shared upstream can back more than one wasteland. The
 * resolver therefore returns the claimants the caller may access
 * instead of picking one by registration recency:
 *
 * - exactly one accessible claimant → `resolved`
 * - several accessible claimants → `ambiguous`, with all of them
 * - none accessible (or none registered) → `none`, which the caller
 *   surfaces the same way as an unregistered address so another
 *   tenant's wasteland id and name are never disclosed
 *
 * Ownership checks for the procedures that consume the resolved
 * `wastelandId` stay where they are (`resolveWastelandOwnership`); this
 * module only answers "which claimant is this caller's?". Both read the
 * same rule from `./access`, so the chooser and the procedures cannot
 * disagree about who reaches a wasteland.
 *
 * The pure entry point `resolveWastelandWith` lives here so unit
 * tests can exercise it without transitively pulling the
 * `cloudflare:workers` import that the DO stub helper requires.
 */

import { canAccessWasteland, type WastelandViewer } from './access';

export type ResolvedWasteland = {
  wastelandId: string;
  ownerType: 'user' | 'org';
  ownerUserId: string | null;
  organizationId: string | null;
  name: string;
  dolthubUpstream: string;
};

export type WastelandResolution =
  | { kind: 'resolved'; wasteland: ResolvedWasteland }
  | { kind: 'ambiguous'; candidates: ResolvedWasteland[] }
  | { kind: 'none' };

/**
 * Minimal contract of the registry stub we need. Defined as a type
 * (not a full DO interface) so unit tests can pass a hand-rolled fake
 * without touching `cloudflare:workers`.
 */
export type RegistryLookup = {
  findAllByOwnerRepo: (
    owner: string,
    repo: string
  ) => Promise<
    Array<{
      wasteland_id: string;
      owner_type: 'user' | 'org';
      owner_user_id: string | null;
      organization_id: string | null;
      name: string;
      dolthub_upstream: string | null;
    }>
  >;
};

export async function resolveWastelandWith(
  registry: RegistryLookup,
  viewer: WastelandViewer,
  args: { owner: string; repo: string }
): Promise<WastelandResolution> {
  const rows = await registry.findAllByOwnerRepo(args.owner, args.repo);

  const accessible: ResolvedWasteland[] = [];
  for (const row of rows) {
    // Defence-in-depth: a row could match while reading back with a
    // null upstream (e.g. a concurrent clear). Such a row cannot answer
    // the address, so skip it instead of failing the whole lookup.
    if (row.dolthub_upstream === null) continue;
    if (!canAccessWasteland(row, viewer)) continue;
    accessible.push({
      wastelandId: row.wasteland_id,
      ownerType: row.owner_type,
      ownerUserId: row.owner_user_id,
      organizationId: row.organization_id,
      name: row.name,
      dolthubUpstream: row.dolthub_upstream,
    });
  }

  if (accessible.length === 0) return { kind: 'none' };
  if (accessible.length === 1) {
    return { kind: 'resolved', wasteland: accessible[0] };
  }
  return { kind: 'ambiguous', candidates: accessible };
}

/**
 * Production entry point — looks up the registry stub from `env`. The
 * dynamic import keeps the `cloudflare:workers`-dependent module out of
 * the static import graph for the pure helper above, so Node-pool unit
 * tests can import this file directly.
 */
export async function resolveWasteland(
  env: Env,
  viewer: WastelandViewer,
  args: { owner: string; repo: string }
): Promise<WastelandResolution> {
  const { getWastelandRegistryStub } = await import('../dos/WastelandRegistry.do');
  const registry = getWastelandRegistryStub(env);
  return resolveWastelandWith(registry, viewer, args);
}
