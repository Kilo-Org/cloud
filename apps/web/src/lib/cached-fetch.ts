/**
 * In-process stale-while-revalidate cache for async fetchers.
 *
 * Returns the cached value immediately if it's younger than `ttlMs`,
 * otherwise calls `fetcher` to refresh. Useful for values that change
 * infrequently (admin config, feature flags, etc.) where paying a
 * network round-trip on every call is wasteful.
 */
export function createCachedFetch<T>(fetcher: () => Promise<T>, ttlMs: number) {
  let cached: { value: T; at: number } | null = null;

  return async function get(): Promise<T> {
    if (cached && Date.now() - cached.at < ttlMs) {
      return cached.value;
    }
    const value = await fetcher();
    cached = { value, at: Date.now() };
    return value;
  };
}
