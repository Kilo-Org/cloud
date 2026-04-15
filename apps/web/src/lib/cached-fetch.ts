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
 */
export function createRedisCachedFetch<T>(
  redisKey: string,
  fetcher: () => Promise<T>,
  ttlMs: number,
  defaultValue: T
) {
  return createCachedFetch(
    async () => {
      const raw = await redisGet(redisKey);
      if (raw) {
        return JSON.parse(raw) as T;
      }
      const value = await fetcher();
      await redisSet(redisKey, JSON.stringify(value), Math.ceil(ttlMs / 1000));
      return value;
    },
    ttlMs,
    defaultValue
  );
}

const redisCacheRegistry = new Map<string, () => Promise<unknown>>();

/**
 * Returns a shared `createRedisCachedFetch` instance for the given key.
 * Useful when the cache is accessed from parameterized functions.
 */
export function getOrCreateRedisCachedFetch<T>(
  redisKey: string,
  fetcher: () => Promise<T>,
  ttlMs: number,
  defaultValue: T
): () => Promise<T> {
  const existing = redisCacheRegistry.get(redisKey);
  if (existing) {
    return existing as () => Promise<T>;
  }
  const cached = createRedisCachedFetch(redisKey, fetcher, ttlMs, defaultValue);
  redisCacheRegistry.set(redisKey, cached);
  return cached;
}
