/**
 * In-process stale-while-revalidate cache for async fetchers.
 *
 * Returns the cached value immediately if it's younger than `ttlMs`,
 * otherwise calls `fetcher` to refresh. If the fetcher throws (e.g.
 * a network timeout), returns the last-known-good cached value, or
 * `defaultValue` if nothing has been cached yet.
 */
export function createCachedFetch<T>(
  fetcher: () => Promise<T>,
  ttlMs: number,
  defaultValue: T,
  failureTtlMs = 0
) {
  let cached: { value: T; at: number } | null = null;
  let inFlight: Promise<T> | null = null;
  let retryAt = 0;

  return async function get(): Promise<T> {
    if (cached && Date.now() - cached.at < ttlMs) {
      return cached.value;
    }
    if (Date.now() < retryAt) {
      return cached?.value ?? defaultValue;
    }

    inFlight ??= Promise.resolve()
      .then(fetcher)
      .then(value => {
        cached = { value, at: Date.now() };
        retryAt = 0;
        return value;
      })
      .catch(() => {
        retryAt = Date.now() + failureTtlMs;
        return cached?.value ?? defaultValue;
      })
      .finally(() => {
        inFlight = null;
      });

    return inFlight;
  };
}
