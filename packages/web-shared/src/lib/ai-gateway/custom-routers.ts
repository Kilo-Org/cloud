import type { CustomRouterDefinition, CustomRouterScope } from '@kilocode/auto-routing-contracts';
import { auto_routing_custom_routers, type AutoRoutingCustomRouter } from '@kilocode/db/schema';
import { asc, eq, or } from 'drizzle-orm';
import { readDb, type db } from '@kilocode/web-shared/lib/drizzle';
import { isReleaseToggleEnabled } from '@kilocode/web-shared/lib/posthog-feature-flags';

export const CUSTOM_ROUTERS_FLAG = 'kilo-auto-custom-routers';

export type CustomRouterOwner = { type: CustomRouterScope; id: string };

export async function isCustomRoutersEnabled(userId: string): Promise<boolean> {
  return (
    process.env.NODE_ENV === 'development' ||
    (await isReleaseToggleEnabled(CUSTOM_ROUTERS_FLAG, userId))
  );
}

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

/**
 * Custom routers usable in a request context (ADR 0005): the user's personal routers, plus the
 * organization's routers in an organization context. Only flagged users create routers, so the
 * flag lookup is skipped when there is nothing to show.
 */
export async function listUsableCustomRouters(params: {
  userId: string;
  organizationId: string | null;
}): Promise<CustomRouterDefinition[]> {
  const owners: CustomRouterOwner[] = [{ type: 'user', id: params.userId }];
  if (params.organizationId) owners.push({ type: 'org', id: params.organizationId });
  const routers = await listCustomRouters(owners);
  if (routers.length === 0 || !(await isCustomRoutersEnabled(params.userId))) return [];
  return routers;
}
