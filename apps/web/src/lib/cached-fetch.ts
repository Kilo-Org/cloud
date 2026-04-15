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
