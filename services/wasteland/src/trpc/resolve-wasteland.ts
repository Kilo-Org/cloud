/**
 * Resolve an `<owner>/<repo>` address to the wasteland that owns that
 * upstream slug. Used by both the `wasteland.resolveOwnerRepo` tRPC
 * procedure and any internal handler that needs to translate a
 * route-style address into a `wastelandId` before invoking a
 * UUID-keyed procedure.
 *
 * Auth/membership is intentionally NOT enforced here. The resolver
 * answers "what wasteland exists at this address?" — the caller
 * decides how to layer authorisation when it forwards the resolved
 * `wastelandId` to a downstream procedure (`getWasteland`,
 * `browseWantedBoard`, etc.).
 *
 * The pure entry point `resolveWastelandWith` lives here so unit
 * tests can exercise it without transitively pulling the
 * `cloudflare:workers` import that the DO stub helper requires.
 */

export type ResolvedWasteland = {
  wastelandId: string;
  ownerType: 'user' | 'org';
  ownerUserId: string | null;
  organizationId: string | null;
  name: string;
  dolthubUpstream: string;
};

/**
 * Minimal contract of the registry stub we need. Defined as a type
 * (not a full DO interface) so unit tests can pass a hand-rolled fake
 * without touching `cloudflare:workers`.
 */
export type RegistryLookup = {
  findByOwnerRepo: (
    owner: string,
    repo: string
  ) => Promise<{
    wasteland_id: string;
    owner_type: 'user' | 'org';
    owner_user_id: string | null;
    organization_id: string | null;
    name: string;
    dolthub_upstream: string | null;
  } | null>;
};

export async function resolveWastelandWith(
  registry: RegistryLookup,
  args: { owner: string; repo: string }
): Promise<ResolvedWasteland | null> {
  const row = await registry.findByOwnerRepo(args.owner, args.repo);
  if (!row) return null;
  if (row.dolthub_upstream === null) {
    // Defence-in-depth: a row could match (e.g. via a prior backfill
    // race) yet read back with a null upstream. Treat that as "not
    // resolvable" — the caller will see the same shape as a true miss.
    return null;
  }
  return {
    wastelandId: row.wasteland_id,
    ownerType: row.owner_type,
    ownerUserId: row.owner_user_id,
    organizationId: row.organization_id,
    name: row.name,
    dolthubUpstream: row.dolthub_upstream,
  };
}

/**
 * Production entry point — looks up the registry stub from `env`. The
 * dynamic import keeps the `cloudflare:workers`-dependent module out of
 * the static import graph for the pure helper above, so Node-pool unit
 * tests can import this file directly.
 */
export async function resolveWasteland(
  env: Env,
  args: { owner: string; repo: string }
): Promise<ResolvedWasteland | null> {
  const { getWastelandRegistryStub } = await import('../dos/WastelandRegistry.do');
  const registry = getWastelandRegistryStub(env);
  return resolveWastelandWith(registry, args);
}
