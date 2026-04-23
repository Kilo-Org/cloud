import { LRUCache } from 'lru-cache';
import { getSandboxOwner } from './sandbox-ownership';

const TTL_MS = 5 * 60 * 1000;
const MAX_ENTRIES = 1024;

type OwnerEntry = { userId: string | null };

const cache = new LRUCache<string, OwnerEntry>({
  max: MAX_ENTRIES,
  ttl: TTL_MS,
});

/**
 * Looks up the active sandbox owner's user_id, cached in-memory for 5 minutes.
 */
export async function lookupSandboxOwnerUserId(
  env: Env,
  sandboxId: string
): Promise<string | null> {
  const hit = cache.get(sandboxId);
  if (hit !== undefined) return hit.userId;

  const userId = await getSandboxOwner(env.HYPERDRIVE.connectionString, sandboxId);
  cache.set(sandboxId, { userId });
  return userId;
}

/** Test-only: reset the cache. */
export function clearSandboxOwnerCacheForTest(): void {
  cache.clear();
}
