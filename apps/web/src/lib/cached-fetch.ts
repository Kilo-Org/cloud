type CachedFetchOptions = {
  /**
   * How long a failed fetch is remembered. Within this window, calls return the
   * fallback without calling `fetcher` again, so an outage does not re-issue
   * (and wait on) the request for every caller. Defaults to 0: retry on the
   * next call.
   */
  failureTtlMs?: number;
};

/**
 * In-process stale-while-revalidate cache for async fetchers.
 *
 * Returns the cached value immediately if it's younger than `ttlMs`,
 * otherwise calls `fetcher` to refresh. Concurrent refreshes share one
 * `fetcher` call. If the fetcher throws (e.g. a network timeout), returns the
 * last-known-good cached value, or `defaultValue` if nothing has been cached
 * yet.
 */
export function createCachedFetch<T>(
  fetcher: () => Promise<T>,
  ttlMs: number,
  defaultValue: T,
  { failureTtlMs = 0 }: CachedFetchOptions = {}
) {
  let cached: { value: T; at: number } | null = null;
  let failedAt: number | null = null;
  let inFlight: Promise<T> | null = null;

  async function refresh(): Promise<T> {
    try {
      const value = await fetcher();
      cached = { value, at: Date.now() };
      failedAt = null;
      return value;
    } catch {
      failedAt = Date.now();
      return cached?.value ?? defaultValue;
    }
  }

  return async function get(): Promise<T> {
    if (cached && Date.now() - cached.at < ttlMs) {
      return cached.value;
    }
    if (failedAt !== null && Date.now() - failedAt < failureTtlMs) {
      return cached?.value ?? defaultValue;
    }
    inFlight ??= refresh().finally(() => {
      inFlight = null;
    });
    return inFlight;
  };
}
