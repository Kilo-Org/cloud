import { LRUCache } from 'lru-cache';
import { userOwnsSandbox } from './sandbox-ownership';

const TTL_MS = 5 * 60 * 1000;
const MAX_ENTRIES = 1024;

const cache = new LRUCache<string, boolean>({
  max: MAX_ENTRIES,
  ttl: TTL_MS,
});

/**
 * Cached version of userOwnsSandbox. Ownership rarely changes within an
 * isolate's lifetime, so a 5-minute TTL avoids repeated Hyperdrive round-trips.
 */
export async function cachedUserOwnsSandbox(
  connectionString: string,
  userId: string,
  sandboxId: string
): Promise<boolean> {
  const key = `${userId}\0${sandboxId}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;

  const result = await userOwnsSandbox(connectionString, userId, sandboxId);
  cache.set(key, result);
  return result;
}

/** Test-only: reset the cache. */
export function clearOwnershipCacheForTest(): void {
  cache.clear();
}
