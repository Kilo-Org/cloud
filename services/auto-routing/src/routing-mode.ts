import {
  AutoRoutingModeSchema,
  DEFAULT_AUTO_ROUTING_MODE,
  type AutoRoutingMode,
  type AutoRoutingModeOwnerType,
} from '@kilocode/auto-routing-contracts';
import { formatError } from '@kilocode/worker-utils';

type AutoRoutingModeEnv = Pick<Env, 'AUTO_ROUTING_CONFIG' | 'AUTO_ROUTING_DB'>;

export const AUTO_ROUTING_MODE_CONFIG_PREFIX = 'auto_routing_mode';

const DEFAULT_CACHE_SENTINEL = '__default__';
const KV_CACHE_TTL_SECONDS = 60;
const MODE_CACHE_TTL_MS = 30_000;
const MAX_MODE_CACHE_ENTRIES = 512;

type CacheEntry = {
  promise: Promise<AutoRoutingMode | null>;
  expiresAt: number;
};

const modeCache = new Map<string, CacheEntry>();

function modeKey(ownerType: AutoRoutingModeOwnerType, ownerId: string): string {
  return `${AUTO_ROUTING_MODE_CONFIG_PREFIX}:${ownerType}:${ownerId}`;
}

function parseStoredMode(raw: unknown): AutoRoutingMode | null {
  const parsed = AutoRoutingModeSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

function parseCachedMode(raw: string | null): AutoRoutingMode | null | undefined {
  if (raw === null) return undefined;
  if (raw === DEFAULT_CACHE_SENTINEL) return null;
  const parsed = AutoRoutingModeSchema.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}

function rememberMode(key: string, promise: Promise<AutoRoutingMode | null>): CacheEntry {
  const entry = { promise, expiresAt: Date.now() + MODE_CACHE_TTL_MS };
  modeCache.set(key, entry);
  if (modeCache.size > MAX_MODE_CACHE_ENTRIES) {
    const oldestKey = modeCache.keys().next().value;
    if (oldestKey) modeCache.delete(oldestKey);
  }
  promise.catch(() => {
    if (modeCache.get(key) === entry) {
      modeCache.delete(key);
    }
  });
  return entry;
}

function updateModeCache(key: string, mode: AutoRoutingMode | null): void {
  rememberMode(key, Promise.resolve(mode));
}

async function readConfiguredModeFromDb(
  env: AutoRoutingModeEnv,
  ownerType: AutoRoutingModeOwnerType,
  ownerId: string
): Promise<AutoRoutingMode | null> {
  const row = await env.AUTO_ROUTING_DB.prepare(
    'SELECT mode FROM auto_routing_modes WHERE owner_type = ? AND owner_id = ? LIMIT 1'
  )
    .bind(ownerType, ownerId)
    .first<{ mode: string }>();
  return parseStoredMode(row?.mode);
}

async function cacheConfiguredMode(
  env: AutoRoutingModeEnv,
  key: string,
  mode: AutoRoutingMode | null
): Promise<void> {
  await env.AUTO_ROUTING_CONFIG.put(key, mode ?? DEFAULT_CACHE_SENTINEL, {
    expirationTtl: KV_CACHE_TTL_SECONDS,
  });
}

async function cacheConfiguredModeBestEffort(
  env: AutoRoutingModeEnv,
  key: string,
  mode: AutoRoutingMode | null
): Promise<void> {
  try {
    await cacheConfiguredMode(env, key, mode);
  } catch (error: unknown) {
    console.warn(
      JSON.stringify({
        event: 'auto_routing_config_cache_write_failed',
        key,
        ...formatError(error),
      })
    );
  }
}

async function loadConfiguredMode(
  env: AutoRoutingModeEnv,
  ownerType: AutoRoutingModeOwnerType,
  ownerId: string
): Promise<AutoRoutingMode | null> {
  const key = modeKey(ownerType, ownerId);
  const cached = modeCache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.promise;
  }
  if (cached) {
    modeCache.delete(key);
  }

  const promise = (async () => {
    const cachedMode = parseCachedMode(await env.AUTO_ROUTING_CONFIG.get(key));
    if (cachedMode !== undefined) {
      return cachedMode;
    }

    const dbMode = await readConfiguredModeFromDb(env, ownerType, ownerId);
    await cacheConfiguredModeBestEffort(env, key, dbMode);
    return dbMode;
  })();
  rememberMode(key, promise);
  return promise;
}

export function clearAutoRoutingModeCache(): void {
  modeCache.clear();
}

export async function getConfiguredAutoRoutingMode(
  env: AutoRoutingModeEnv,
  owner: { ownerType: AutoRoutingModeOwnerType; ownerId: string }
): Promise<AutoRoutingMode | null> {
  return loadConfiguredMode(env, owner.ownerType, owner.ownerId).catch((error: unknown) => {
    console.warn(
      JSON.stringify({
        event: 'auto_routing_config_read_failed',
        key: modeKey(owner.ownerType, owner.ownerId),
        ...formatError(error),
      })
    );
    return null;
  });
}

export async function getAutoRoutingMode(
  env: AutoRoutingModeEnv,
  owner: { userId: string; organizationId: string | null }
): Promise<AutoRoutingMode> {
  if (owner.organizationId) {
    const orgMode = await getConfiguredAutoRoutingMode(env, {
      ownerType: 'org',
      ownerId: owner.organizationId,
    });
    if (orgMode) return orgMode;
  }

  const userMode = await getConfiguredAutoRoutingMode(env, {
    ownerType: 'user',
    ownerId: owner.userId,
  });
  return userMode ?? DEFAULT_AUTO_ROUTING_MODE;
}

export async function setAutoRoutingMode(
  env: AutoRoutingModeEnv,
  owner: { ownerType: AutoRoutingModeOwnerType; ownerId: string },
  mode: AutoRoutingMode | null
): Promise<void> {
  const key = modeKey(owner.ownerType, owner.ownerId);
  if (mode === null) {
    await env.AUTO_ROUTING_DB.prepare(
      'DELETE FROM auto_routing_modes WHERE owner_type = ? AND owner_id = ?'
    )
      .bind(owner.ownerType, owner.ownerId)
      .run();
  } else {
    await env.AUTO_ROUTING_DB.prepare(
      `INSERT INTO auto_routing_modes (owner_type, owner_id, mode, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(owner_type, owner_id) DO UPDATE SET
         mode = excluded.mode,
         updated_at = excluded.updated_at`
    )
      .bind(owner.ownerType, owner.ownerId, mode, new Date().toISOString())
      .run();
  }
  updateModeCache(key, mode);
  await cacheConfiguredModeBestEffort(env, key, mode);
}
