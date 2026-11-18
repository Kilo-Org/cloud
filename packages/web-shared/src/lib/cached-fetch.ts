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
 * result from a fallback; the warning, and the `onRefreshFailure` reporter when
 * one is passed, are how a failure becomes observable.
 * A failure does not make the stored value younger; once the backoff window
 * passes the next call refreshes normally.
 */

export const FAILURE_BACKOFF_MS = 30_000;

type CacheWrite<T> = {
  value: T;
  /** When the value was stored; `-Infinity` for a fallback, which is never fresh. */
  at: number;
  /** Earliest time at which the next refresh may start; `-Infinity` after a success. */
  retryAfterMs: number;
  /** Whether `value` came from a successful fetch rather than a failure fallback. */
  knownGood: boolean;
};

/** What a failed refresh reports to `onRefreshFailure`. */
export type RefreshFailureInfo = {
  /** The cache's `name`. */
  name: string;
  /** The value the fetcher rejected with, unchanged. */
  error: unknown;
  /** The value this failure served instead of a fresh result. */
  served: 'default' | 'last-known-good';
  /** How long this failure suppresses further refresh attempts. */
  failureBackoffMs: number;
};

export type CreateCachedFetchOptions = {
  /** Identifies this cache in the warning a failed refresh reports. */
  name: string;
  /**
   * How long a failed refresh suppresses further attempts. `0` retries on the
   * next call, which restores the pre-backoff behaviour.
   */
  failureBackoffMs?: number;
  /**
   * Clock the cache reads for its TTL and its failure deadline. Defaults to
   * `Date.now`; inject one to make the timing contract testable.
   */
  now?: () => number;
  /**
   * Called once per failed refresh window, after the fallback value is stored.
   * A report that throws or rejects cannot change what callers receive.
   */
  onRefreshFailure?: (info: RefreshFailureInfo) => void | Promise<void>;
};

export function createCachedFetch<T>(
  fetcher: () => Promise<T>,
  ttlMs: number,
  defaultValue: T,
  options: CreateCachedFetchOptions
) {
  const { name, onRefreshFailure } = options;
  const failureBackoffMs = options.failureBackoffMs ?? FAILURE_BACKOFF_MS;
  // Read the ambient clock per call, so a cache created at module scope keeps
  // observing a `Date.now` that is replaced after it was created.
  const now = () => (options.now ?? Date.now)();
  let cached: CacheWrite<T> | null = null;
  let inFlight: Promise<T> | null = null;

  return async function get(): Promise<T> {
    const nowMs = now();
    if (cached && nowMs - cached.at < ttlMs) {
      return cached.value;
    }
    if (cached && nowMs < cached.retryAfterMs) {
      return cached.value;
    }
    if (inFlight) {
      return await inFlight;
    }

    const refresh = (async (): Promise<T> => {
      try {
        const value = await fetcher();
        cached = {
          value,
          at: now(),
          retryAfterMs: Number.NEGATIVE_INFINITY,
          knownGood: true,
        };
        return value;
      } catch (error) {
        // Concurrent callers share this promise, so the refresh never rejects.
        // The attempt runs at most once per backoff window, so reporting here
        // reports each failure window once. The stored timestamp makes the
        // fallback permanently stale, so the freshness check cannot mask the
        // backoff window with a still-fresh last-known-good value, whatever
        // origin the clock has.
        const knownGood = cached?.knownGood ?? false;
        const served = knownGood ? 'last-known-good' : 'default';
        const reason = (error instanceof Error ? error.message : String(error))
          .replace(/\s+/g, ' ')
          .trim();
        warnExceptInTest(
          `[cached-fetch] ${name} refresh failed: ${reason}; serving the ${served} value, retrying in ${failureBackoffMs}ms`
        );
        const value = cached?.value ?? defaultValue;
        cached = {
          value,
          at: Number.NEGATIVE_INFINITY,
          retryAfterMs: now() + failureBackoffMs,
          knownGood,
        };
        if (onRefreshFailure) {
          try {
            // The fallback is already stored, so a report that throws or rejects
            // must not reject the shared refresh every concurrent caller awaits,
            // nor become an unhandled rejection.
            void Promise.resolve(onRefreshFailure({ name, error, served, failureBackoffMs })).catch(
              () => {}
            );
          } catch {
            // A synchronous throw is swallowed for the same reason.
          }
        }
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
