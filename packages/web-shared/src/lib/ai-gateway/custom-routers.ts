import type { CustomRouterDefinition, CustomRouterScope } from '@kilocode/auto-routing-contracts';
import { auto_routing_custom_routers, type AutoRoutingCustomRouter } from '@kilocode/db/schema';
2:   findCustomRouter,
3: export async function dataCollectionRequiredAutoRoutingCandidates(
  candidateIds: ReadonlyArray<string>
): Promise<string[]> {
  return dataCollectionRequiredCandidates(candidateIds, await getDataCollectionRequiredModelIds());
}

export async function collectDataCollectionRequiredAutoRoutingModelIds(): Promise<string[]> {
  const [table, dataCollectionRequiredModelIds] = await Promise.all([
    getCachedRoutingTable(),
4: import { and, asc, eq, or } from 'drizzle-orm';
import { readDb, type db, type DrizzleTransaction } from '@kilocode/web-shared/lib/drizzle';
5:       const deniedModelIds = await autoRoutingDenials(
        policy => collectDeniedAutoRoutingModelIds(policy),
        () => collectDataCollectionRequiredAutoRoutingModelIds()
      );

export type CustomRouterOwner = { type: CustomRouterScope; id: string };

export function customRouterOwnerCondition(owner: CustomRouterOwner) {
  return owner.type === 'user'
    ? eq(auto_routing_custom_routers.owned_by_user_id, owner.id)
    : eq(auto_routing_custom_routers.owned_by_organization_id, owner.id);
}

function rowOwner(row: AutoRoutingCustomRouter): CustomRouterOwner {
  if (row.owned_by_organization_id) return { type: 'org', id: row.owned_by_organization_id };
  if (row.owned_by_user_id) return { type: 'user', id: row.owned_by_user_id };
  throw new Error(`Custom router ${row.id} has no owner`);
}

export function toCustomRouterDefinition(row: AutoRoutingCustomRouter): CustomRouterDefinition {
  const owner = rowOwner(row);
  return {
    id: row.id,
    ownerType: owner.type,
    ownerId: owner.id,
    slug: row.slug,
    name: row.name,
    baseRouter: row.base_router,
    mode: row.mode,
    entries: row.entries,
    defaultEntryKey: row.default_entry_key,
  };
}

export async function listCustomRouters(
  owners: CustomRouterOwner[],
  fromDb: typeof db = readDb
): Promise<CustomRouterDefinition[]> {
  if (owners.length === 0) return [];
  const rows = await fromDb
    .select()
    .from(auto_routing_custom_routers)
    .where(or(...owners.map(customRouterOwnerCondition)))
    .orderBy(asc(auto_routing_custom_routers.created_at), asc(auto_routing_custom_routers.id));
  return rows.map(toCustomRouterDefinition);
}

export async function findCustomRouter(
  owner: CustomRouterOwner,
  slug: string,
  fromDb: typeof db | DrizzleTransaction = readDb
): Promise<CustomRouterDefinition | null> {
  const [row] = await fromDb
    .select()
    .from(auto_routing_custom_routers)
    .where(and(customRouterOwnerCondition(owner), eq(auto_routing_custom_routers.slug, slug)))
    .limit(1);
  return row ? toCustomRouterDefinition(row) : null;
}

/**
 * Custom routers usable in a request context (ADR 0005): the user's personal routers, plus the
 * organization's routers in an organization context.
 */
export async function listUsableCustomRouters(params: {
  userId: string;
  organizationId: string | null;
}): Promise<CustomRouterDefinition[]> {
  const owners: CustomRouterOwner[] = [{ type: 'user', id: params.userId }];
  if (params.organizationId) owners.push({ type: 'org', id: params.organizationId });
  return listCustomRouters(owners);
}
