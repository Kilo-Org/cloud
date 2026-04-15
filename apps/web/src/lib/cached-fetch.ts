import { redisGet, redisSet } from '@/lib/redis';

/**
 * In-process stale-while-revalidate cache for async fetchers.
 *
 * Returns the cached value immediately if it's younger than `ttlMs`,
 * otherwise calls `fetcher` to refresh. If the fetcher throws (e.g.
 * Redis timeout), returns the last-known-good cached value, or
 * `defaultValue` if nothing has been cached yet.
 */
export function createCachedFetch<T>(fetcher: () => Promise<T>, ttlMs: number, defaultValue: T) {
  let cached: { value: T; at: number } | null = null;

  return async function get(): Promise<T> {
    if (cached && Date.now() - cached.at < ttlMs) {
      return cached.value;
    }
    try {
      const value = await fetcher();
      cached = { value, at: Date.now() };
      return value;
    } catch {
      return cached?.value ?? defaultValue;
    }
  };
}

/**
 * Combines `createCachedFetch` with Redis caching.
 *
 * Checks Redis first; on miss, calls `fetcher`, stores the result in Redis,
 * and caches it in-process. Only writes to Redis when a fresh value is
 * fetched, so existing values are never overwritten by stale data.
 *
 * Unlike `createCachedFetch`, this throws on a true cold-cache failure
 * (both Redis and the fetcher are unavailable) so callers can decide
 * whether to fail open or handle the error explicitly.
 */
export function createRedisCachedFetch<T>(
  redisKey: string,
  fetcher: () => Promise<T>,
  ttlMs: number
) {
  let cached: { value: T; at: number } | null = null;

  return async function get(): Promise<T> {
    if (cached && Date.now() - cached.at < ttlMs) {
      return cached.value;
    }

    try {
      const raw = await redisGet(redisKey);
      if (raw) {
        const value = JSON.parse(raw) as T;
        cached = { value, at: Date.now() };
        return value;
      }
    } catch {
      // Redis GET failed; fall through to fetcher and stale-cache logic below
    }

    try {
      const value = await fetcher();
      try {
        await redisSet(redisKey, JSON.stringify(value), Math.ceil(ttlMs / 1000));
      } catch {
        // Ignore Redis SET failures so a write outage doesn't fail requests
      }
      cached = { value, at: Date.now() };
      return value;
    } catch (err) {
      if (cached) {
        return cached.value;
      }
      throw err;
    }
  };
}

const redisCacheRegistry = new Map<string, () => Promise<unknown>>();
const MAX_REGISTRY_SIZE = 100;

function touchRegistryKey(key: string): void {
  const fn = redisCacheRegistry.get(key);
  if (fn) {
    redisCacheRegistry.delete(key);
    redisCacheRegistry.set(key, fn);
  }
}

/**
 * Returns a shared `createRedisCachedFetch` instance for the given key.
 * Useful when the cache is accessed from parameterized functions.
 * The registry is bounded to `MAX_REGISTRY_SIZE` entries with LRU eviction.
 */
export function getOrCreateRedisCachedFetch<T>(
  redisKey: string,
  fetcher: () => Promise<T>,
  ttlMs: number
): () => Promise<T> {
  const existing = redisCacheRegistry.get(redisKey);
  if (existing) {
    touchRegistryKey(redisKey);
    return existing as () => Promise<T>;
  }

  if (redisCacheRegistry.size >= MAX_REGISTRY_SIZE) {
    const firstKey = redisCacheRegistry.keys().next().value as string | undefined;
    if (firstKey) {
      redisCacheRegistry.delete(firstKey);
    }
  }

  const cached = createRedisCachedFetch(redisKey, fetcher, ttlMs);
  redisCacheRegistry.set(redisKey, cached);
  return cached;
}
