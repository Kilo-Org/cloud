/**
 * In-process stale-while-revalidate cache for async fetchers.
 *
 * - Fresh cache (age < ttlMs): returned immediately, no fetch.
 * - Stale cache (age ≥ ttlMs): stale value returned immediately and a
 *   background refresh is kicked off (fire-and-forget). The refresh
 *   updates the cache on success, or leaves it untouched on failure so
 *   the stale value keeps serving.
 * - No cache yet: the first call awaits the fetcher. On failure it
 *   resolves to `defaultValue`.
 * - Concurrent callers that trigger a refresh share the same in-flight
 *   promise, so a burst of requests results in exactly one fetch.
 */
export function createCachedFetch<T>(fetcher: () => Promise<T>, ttlMs: number, defaultValue: T) {
  let cached: { value: T; at: number } | null = null;
  let inFlight: Promise<T> | null = null;

  function refresh(): Promise<T> {
    if (inFlight) return inFlight;
    inFlight = fetcher()
      .then(value => {
        cached = { value, at: Date.now() };
        return value;
      })
      .catch(() => cached?.value ?? defaultValue)
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  }

  return async function get(): Promise<T> {
    if (cached && Date.now() - cached.at < ttlMs) {
      return cached.value;
    }
    if (cached) {
      // Stale-while-revalidate: serve stale immediately, refresh in the background.
      void refresh();
      return cached.value;
    }
    return refresh();
  };
}
