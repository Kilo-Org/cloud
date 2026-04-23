import { getSandboxOwner } from './sandbox-ownership';

type CacheEntry = { userId: string | null; cachedAt: number };

const TTL_MS = 5 * 60 * 1000;
const MAX_ENTRIES = 1024;

const cache = new Map<string, CacheEntry>();

function prune(now: number): void {
  for (const [key, entry] of cache) {
    if (now - entry.cachedAt > TTL_MS) cache.delete(key);
  }
  if (cache.size > MAX_ENTRIES) {
    // Drop oldest half.
    const toDrop = cache.size - MAX_ENTRIES / 2;
    let i = 0;
    for (const key of cache.keys()) {
      if (i++ >= toDrop) break;
      cache.delete(key);
    }
  }
}

/**
 * Looks up the active sandbox owner's user_id, cached in-memory for 5 minutes.
 */
export async function lookupSandboxOwnerUserId(
  env: Env,
  sandboxId: string
): Promise<string | null> {
  const now = Date.now();
  const hit = cache.get(sandboxId);
  if (hit && now - hit.cachedAt < TTL_MS) return hit.userId;

  const userId = await getSandboxOwner(env.HYPERDRIVE.connectionString, sandboxId);
  cache.set(sandboxId, { userId, cachedAt: now });
  prune(now);
  return userId;
}

/** Test-only: reset the cache. */
export function clearSandboxOwnerCacheForTest(): void {
  cache.clear();
}
