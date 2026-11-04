import { warnExceptInTest } from '@kilocode/web-shared/lib/utils.server';

/**
 * In-process TTL cache for async fetchers with single-flight refresh and failure backoff.
 *
 * Returns the cached value immediately if it's younger than `ttlMs`,
 * otherwise calls `fetcher` to refresh. If calling or awaiting the fetcher
 * throws (e.g. a network timeout), returns the last-known-good cached value,
 * or `defaultValue` if no fetch has succeeded yet.
 *
 * Callers that arrive while a refresh is in flight share that refresh, so an
 * expired entry never produces more than one concurrent underlying fetch.
 *
 * Every failed refresh is reported once, with `warnExceptInTest`, under the
 * `name` the caller gives its cache, and is negatively cached for
 * `failureBackoffMs`: callers keep receiving the last-known-good or default
 * value and no new fetch is attempted until the window passes, so an outage
 * does not amplify into one failing fetch per request. Because the returned
 * promise always resolves, the returned value alone cannot distinguish a fresh
 * result from a fallback; that warning is how a failure becomes observable.
 * A failure does not make the stored value younger; once the backoff window
 * passes the next call refreshes normally.
 */

export const FAILURE_BACKOFF_MS = 30_000;

type CacheWrite<T> = {
  value: T;
  /** When the value was stored. */
  at: number;
  /** Earliest time at which the next refresh may start. */
  retryAfterMs: number;
  /** Whether `value` came from a successful fetch rather than a failure fallback. */
  knownGood: boolean;
};

export type CreateCachedFetchOptions = {
  /** Identifies this cache in the warning a failed refresh reports. */
  name: string;
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
  options: CreateCachedFetchOptions
) {
  const { name } = options;
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
        cached = { value, at: Date.now(), retryAfterMs: 0, knownGood: true };
        return value;
      } catch (error) {
        // Concurrent callers share this promise, so the refresh never rejects.
        // The attempt runs at most once per backoff window, so reporting here
        // reports each failure window once. The stored clock resets, so the
        // freshness check cannot mask the backoff window with a still-fresh
        // last-known-good value.
        const knownGood = cached?.knownGood ?? false;
        const reason = (error instanceof Error ? error.message : String(error))
          .replace(/\s+/g, ' ')
          .trim();
        warnExceptInTest(
          `[cached-fetch] ${name} refresh failed: ${reason}; serving the ${
            knownGood ? 'last-known-good' : 'default'
          } value, retrying in ${failureBackoffMs}ms`
        );
        const value = cached?.value ?? defaultValue;
        cached = { value, at: 0, retryAfterMs: Date.now() + failureBackoffMs, knownGood };
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
