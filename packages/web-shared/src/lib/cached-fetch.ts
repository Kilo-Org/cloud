/**
 * In-process stale-while-revalidate cache for async fetchers.
 *
 * Returns the cached value immediately if it's younger than `ttlMs`,
 * otherwise calls `fetcher` to refresh. If calling or awaiting the fetcher
 * throws (e.g. a network timeout), returns the last-known-good cached value,
 * or `defaultValue` if nothing has been cached yet.
 *
 * Callers that arrive while a refresh is in flight share that refresh, so an
 * expired entry never produces more than one concurrent underlying fetch.
 *
 * A failed refresh is negatively cached for `failureBackoffMs`: callers keep
 * receiving the last-known-good or default value and no new fetch is attempted
 * until the window passes, so an outage does not amplify into one failing fetch
 * per request. A failure does not make the stored value younger; once the
 * backoff window passes the next call refreshes normally.
 */

export const FAILURE_BACKOFF_MS = 30_000;

type CacheWrite<T> = {
  value: T;
  /** When the value was stored. */
  at: number;
  /** Earliest time at which the next refresh may start. */
  retryAfterMs: number;
};

export type CreateCachedFetchOptions = {
  /**
   * How long a failed refresh suppresses further attempts. `0` retries on the
   * next call, which restores the pre-backoff behaviour.
   */
  failureBackoffMs?: number;
};

export function createCachedFetch<T>(
  fetcher: () => Promise<T>,
  ttlMs: number,
  defaultValue: T,
  options: CreateCachedFetchOptions = {}
) {
  const failureBackoffMs = options.failureBackoffMs ?? FAILURE_BACKOFF_MS;
  let cached: CacheWrite<T> | null = null;
  let inFlight: Promise<T> | null = null;

  return async function get(): Promise<T> {
    const now = Date.now();
    if (cached && now - cached.at < ttlMs) {
      return cached.value;
    }
    if (cached && now < cached.retryAfterMs) {
      return cached.value;
    }
    if (inFlight) {
      return await inFlight;
    }

    const refresh = (async (): Promise<T> => {
      try {
        const value = await fetcher();
        cached = { value, at: Date.now(), retryAfterMs: 0 };
        return value;
      } catch {
        // A failure is observed once, by the caller that started the refresh;
        // concurrent callers share this promise, so it never rejects. The
        // stored clock resets, so the freshness check cannot mask the backoff
        // window with a still-fresh last-known-good value.
        const value = cached?.value ?? defaultValue;
        cached = { value, at: 0, retryAfterMs: Date.now() + failureBackoffMs };
        return value;
      }
    })();

    inFlight = refresh;
    try {
      return await refresh;
    } finally {
      inFlight = null;
    }
  };
}
