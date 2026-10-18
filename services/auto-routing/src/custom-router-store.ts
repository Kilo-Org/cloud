import {
  CustomRouterDefinitionSchema,
  type CustomRouterDefinition,
  type CustomRouterScope,
} from '@kilocode/auto-routing-contracts';
import {
  auto_routing_custom_routers,
  getWorkerDb,
  type AutoRoutingCustomRouter,
} from '@kilocode/db';
import { and, eq, type SQL } from 'drizzle-orm';

// The web app owns writes; a saved edit reaches every isolate within this TTL.
const CUSTOM_ROUTER_CACHE_TTL_MS = 30_000;
const CUSTOM_ROUTER_CACHE_LIMIT = 2_000;

export type CustomRouterOwner = { type: CustomRouterScope; id: string };

type CacheEntry = { expiresAt: number; value: Promise<CustomRouterDefinition | null> };

const cache = new Map<string, CacheEntry>();

export function clearCustomRouterCache(): void {
  cache.clear();
}

export function toCustomRouterDefinition(row: AutoRoutingCustomRouter): CustomRouterDefinition {
  const owner: CustomRouterOwner = row.owned_by_organization_id
    ? { type: 'org', id: row.owned_by_organization_id }
    : { type: 'user', id: row.owned_by_user_id ?? '' };
  const parsed = CustomRouterDefinitionSchema.safeParse({
    id: row.id,
    ownerType: owner.type,
    ownerId: owner.id,
    slug: row.slug,
    name: row.name,
    baseRouter: row.base_router,
    mode: row.mode,
    entries: row.entries,
    defaultEntryKey: row.default_entry_key,
  });
  if (!parsed.success) {
    throw new Error(
      `custom router ${row.id} is invalid: ${parsed.error.issues[0]?.message ?? 'unknown'}`
    );
  }
  return parsed.data;
}

async function queryRouter(
  env: Pick<Env, 'HYPERDRIVE'>,
  where: SQL | undefined
): Promise<CustomRouterDefinition | null> {
  const db = getWorkerDb(env.HYPERDRIVE.connectionString, { statement_timeout: 2_000 });
  const [row] = await db.select().from(auto_routing_custom_routers).where(where).limit(1);
  return row ? toCustomRouterDefinition(row) : null;
}

function cached(
  key: string,
  load: () => Promise<CustomRouterDefinition | null>
): Promise<CustomRouterDefinition | null> {
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && hit.expiresAt > now) return hit.value;
  const value = load();
  cache.delete(key);
  cache.set(key, { expiresAt: now + CUSTOM_ROUTER_CACHE_TTL_MS, value });
  value.catch(() => {
    if (cache.get(key)?.value === value) cache.delete(key);
  });
  if (cache.size > CUSTOM_ROUTER_CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  return value;
}

export function findCustomRouter(
  env: Pick<Env, 'HYPERDRIVE'>,
  owner: CustomRouterOwner,
  slug: string
): Promise<CustomRouterDefinition | null> {
  const load = () =>
    queryRouter(
      env,
      and(
        owner.type === 'org'
          ? eq(auto_routing_custom_routers.owned_by_organization_id, owner.id)
          : eq(auto_routing_custom_routers.owned_by_user_id, owner.id),
        eq(auto_routing_custom_routers.slug, slug)
      )
    );
  return cached(`${owner.type}:${owner.id}:${slug}`, load);
}

export function findCustomRouterById(
  env: Pick<Env, 'HYPERDRIVE'>,
  routerId: string
): Promise<CustomRouterDefinition | null> {
  return cached(`id:${routerId}`, () =>
    queryRouter(env, eq(auto_routing_custom_routers.id, routerId))
  );
}
