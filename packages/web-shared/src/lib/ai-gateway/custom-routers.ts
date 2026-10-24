import type { CustomRouterDefinition, OwnerType } from '@kilocode/auto-routing-contracts';
import { auto_routing_custom_routers, type AutoRoutingCustomRouter } from '@kilocode/db/schema';
import { and, asc, eq, or } from 'drizzle-orm';
import { db, readDb, type DrizzleTransaction } from '@kilocode/web-shared/lib/drizzle';
import { getAutoRoutingSettings } from '@kilocode/web-shared/lib/ai-gateway/auto-routing-admin-client';

export type CustomRouterOwner = { type: OwnerType; id: string };

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
    legacyPool: row.legacy_pool,
    legacyModeInherited: row.legacy_mode_inherited,
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
  fromDb: typeof db | DrizzleTransaction = db
): Promise<CustomRouterDefinition | null> {
  const [row] = await fromDb
    .select()
    .from(auto_routing_custom_routers)
    .where(and(customRouterOwnerCondition(owner), eq(auto_routing_custom_routers.slug, slug)))
    .limit(1);
  return row ? toCustomRouterDefinition(row) : null;
}

export async function findLegacyPoolRouter(
  owner: CustomRouterOwner,
  fromDb: typeof db | DrizzleTransaction = db
): Promise<CustomRouterDefinition | null> {
  const [row] = await fromDb
    .select()
    .from(auto_routing_custom_routers)
    .where(
      and(customRouterOwnerCondition(owner), eq(auto_routing_custom_routers.legacy_pool, true))
    )
    .limit(1);
  return row ? toCustomRouterDefinition(row) : null;
}

export async function findEffectiveLegacyPoolRouter(params: {
  userId: string;
  organizationId: string | null;
}): Promise<CustomRouterDefinition | null> {
  const [personal, organization] = await Promise.all([
    findLegacyPoolRouter({ type: 'user', id: params.userId }),
    params.organizationId ? findLegacyPoolRouter({ type: 'org', id: params.organizationId }) : null,
  ]);
  if (organization) return organization;
  if (!personal || !params.organizationId) return personal;
  const settings = await getAutoRoutingSettings({
    ownerType: 'org',
    ownerId: params.organizationId,
  });
  if (settings.status === 200 && 'configuredPool' in settings.body) {
    return settings.body.configuredPool?.length ? null : personal;
  }
  throw new Error('Could not resolve the organization pool during the migration notice period');
}

export async function listUsableCustomRouters(params: {
  userId: string;
  organizationId: string | null;
}): Promise<CustomRouterDefinition[]> {
  const owners: CustomRouterOwner[] = [{ type: 'user', id: params.userId }];
  if (params.organizationId) owners.push({ type: 'org', id: params.organizationId });
  return listCustomRouters(owners, db);
}
