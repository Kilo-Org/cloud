import {
  CustomRouterDefinitionSchema,
  type CustomRouterDefinition,
  type CustomRouterEntry,
  type OwnerType,
} from '@kilocode/auto-routing-contracts';
import {
  ai_gateway_config,
  auto_routing_custom_routers,
  getWorkerDb,
  type AutoRoutingCustomRouter,
} from '@kilocode/db';
import { LatestAliasTargetsConfigSchema } from '@kilocode/db/schema-types';
import { isDirectByokModelId } from '@kilocode/worker-utils/direct-byok-model';
import { and, eq, sql, type SQL } from 'drizzle-orm';

// The web app owns writes; a saved edit reaches every isolate within this TTL.
const CUSTOM_ROUTER_CACHE_TTL_MS = 30_000;
const CUSTOM_ROUTER_CACHE_LIMIT = 2_000;

export type CustomRouterOwner = { type: OwnerType; id: string };

type CacheEntry = {
  expiresAt: number;
  value: CustomRouterDefinition | null;
  /** Database time of the read that proved this value, or null for a TTL-only read. */
  observedAtMs: number | null;
  /** Start order of the read that produced this value, so an older read never replaces a newer one. */
  sequence: number;
};

const cache = new Map<string, CacheEntry>();

let readSequence = 0;

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

function ownerSlugWhere(owner: CustomRouterOwner, slug: string): SQL | undefined {
  return and(
    owner.type === 'org'
      ? eq(auto_routing_custom_routers.owned_by_organization_id, owner.id)
      : eq(auto_routing_custom_routers.owned_by_user_id, owner.id),
    eq(auto_routing_custom_routers.slug, slug)
  );
}

async function queryRouter(
  env: Pick<Env, 'HYPERDRIVE'>,
  where: SQL | undefined
): Promise<CustomRouterDefinition | null> {
  const db = getWorkerDb(env.HYPERDRIVE.connectionString, { statement_timeout: 2_000 });
  const [row] = await db.select().from(auto_routing_custom_routers).where(where).limit(1);
  return row ? toCustomRouterDefinition(row) : null;
}

/** A gateway entry whose model is a `~` alias and whose target the pool serves itself. */
function isGatewayAliasEntry(entry: CustomRouterEntry): boolean {
  return (
    entry.kind === 'gateway' &&
    entry.model.startsWith('~') &&
    entry.measuredAs === undefined &&
    !isDirectByokModelId(entry.model)
  );
}

/**
 * True when an alias change can move what this pool dispatches. A pool without such an entry
 * has no serving pin to chase, so it keeps the plain TTL read.
 */
export function hasGatewayAlias(router: CustomRouterDefinition): boolean {
  return router.entries.some(isGatewayAliasEntry);
}

function storeCached(key: string, entry: CacheEntry): void {
  cache.delete(key);
  cache.set(key, entry);
  if (cache.size > CUSTOM_ROUTER_CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
}

/**
 * A read that started before the cached answer must never replace it, and neither may a read that
 * started before an observation landed: a slower answer never becomes the current one.
 */
function storeRead(key: string, entry: CacheEntry, started: CacheEntry | undefined): void {
  const existing = cache.get(key);
  if (existing !== undefined && existing !== started) {
    if (existing.sequence > entry.sequence) return;
    if (existing.observedAtMs !== null) return;
  }
  storeCached(key, entry);
}

async function cached(
  key: string,
  load: () => Promise<CustomRouterDefinition | null>
): Promise<CustomRouterDefinition | null> {
  const started = cache.get(key);
  const startedAt = Date.now();
  if (started && started.expiresAt > startedAt) return started.value;
  readSequence += 1;
  const sequence = readSequence;
  // Only a resolved read is cached: workerd binds a promise's I/O to the request that created it,
  // so a request that awaited another request's pending read would fail when that one was cancelled.
  const value = await load();
  // The TTL runs from the start of the read, so a slow read cannot extend how long an old answer is
  // served.
  storeRead(
    key,
    { expiresAt: startedAt + CUSTOM_ROUTER_CACHE_TTL_MS, value, observedAtMs: null, sequence },
    started
  );
  return value;
}

export type ServingCustomRouter = {
  router: CustomRouterDefinition;
  /**
   * Alias -> stable stored concrete target, from the same statement as the pool. Empty when the
   * pool was served from the TTL read.
   */
  aliasTargets: ReadonlyMap<string, string>;
};

type AuthoritativeCustomRouter = {
  router: CustomRouterDefinition;
  aliasTargets: ReadonlyMap<string, string>;
  observedAtMs: number;
};

function storedAliasTargets(config: unknown): ReadonlyMap<string, string> {
  if (config === null || config === undefined) return new Map();
  const parsed = LatestAliasTargetsConfigSchema.safeParse(config);
  if (!parsed.success) return new Map();
  return new Map(parsed.data.aliases.map(alias => [alias.alias, alias.target] as const));
}

/**
 * The saved pool and the stored alias targets read in one statement, so a caller signs what one
 * database snapshot said: a promotion writes the observed pin and the new target in one
 * transaction, and a second read could land after the next move. `clock_timestamp()` makes the
 * statement uncacheable for Hyperdrive — Cloudflare does not cache a read that calls a volatile
 * function, and it warns that comment text is not a cache control — and its value orders this read
 * against the process cache: a slower observation never replaces a newer one.
 */
async function findAuthoritativeCustomRouter(
  env: Pick<Env, 'HYPERDRIVE'>,
  owner: CustomRouterOwner,
  slug: string
): Promise<AuthoritativeCustomRouter | null> {
  const db = getWorkerDb(env.HYPERDRIVE.connectionString, { statement_timeout: 2_000 });
  const [row] = await db
    .select({
      router: auto_routing_custom_routers,
      aliasTargets: ai_gateway_config.latest_alias_targets,
      observedAtMs: sql<number>`(extract(epoch FROM clock_timestamp()) * 1000)::float8`,
    })
    .from(auto_routing_custom_routers)
    .leftJoin(ai_gateway_config, eq(ai_gateway_config.id, 1))
    .where(ownerSlugWhere(owner, slug))
    .limit(1);
  if (!row) return null;
  const observedAtMs: unknown = row.observedAtMs;
  if (typeof observedAtMs !== 'number' || !Number.isFinite(observedAtMs)) {
    throw new Error('custom router freshness read returned no database clock');
  }
  return {
    router: toCustomRouterDefinition(row.router),
    aliasTargets: storedAliasTargets(row.aliasTargets),
    observedAtMs,
  };
}

function rememberObservation(
  key: string,
  router: CustomRouterDefinition | null,
  observedAtMs: number
): void {
  const hit = cache.get(key);
  if (hit && hit.observedAtMs !== null && hit.observedAtMs > observedAtMs) return;
  readSequence += 1;
  storeCached(key, {
    expiresAt: Date.now() + CUSTOM_ROUTER_CACHE_TTL_MS,
    value: router,
    observedAtMs,
    sequence: readSequence,
  });
}

export function findCustomRouter(
  env: Pick<Env, 'HYPERDRIVE'>,
  owner: CustomRouterOwner,
  slug: string
): Promise<CustomRouterDefinition | null> {
  return cached(`${owner.type}:${owner.id}:${slug}`, () =>
    queryRouter(env, ownerSlugWhere(owner, slug))
  );
}

/**
 * The pool a decision must route from, and the stored alias targets from the same snapshot. A
 * cached value with any `~` alias gateway entry is not trustworthy on its own: an alias promotion
 * writes the observed pin and the new target atomically in PostgreSQL, and neither the process
 * cache nor Hyperdrive's query cache sees that write. Such a pool is re-read on the database
 * clock together with the alias targets; a row that read no longer finds is a revoked pool, so the
 * caller refuses it instead of falling back to the stale definition. A pool without an alias entry
 * keeps the plain TTL read.
 */
export async function findServingCustomRouter(
  env: Pick<Env, 'HYPERDRIVE'>,
  owner: CustomRouterOwner,
  slug: string
): Promise<ServingCustomRouter | null> {
  const router = await findCustomRouter(env, owner, slug);
  if (!router || !hasGatewayAlias(router)) {
    return router ? { router, aliasTargets: new Map() } : null;
  }
  const observed = await findAuthoritativeCustomRouter(env, owner, slug);
  if (!observed) return null;
  rememberObservation(`${owner.type}:${owner.id}:${slug}`, observed.router, observed.observedAtMs);
  return { router: observed.router, aliasTargets: observed.aliasTargets };
}

export function findCustomRouterById(
  env: Pick<Env, 'HYPERDRIVE'>,
  routerId: string
): Promise<CustomRouterDefinition | null> {
  return cached(`id:${routerId}`, () =>
    queryRouter(env, eq(auto_routing_custom_routers.id, routerId))
  );
}
