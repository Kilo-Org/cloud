import { TRPCError } from '@trpc/server';
import { captureException } from '@sentry/nextjs';

import { readDb } from '@kilocode/web-shared/lib/drizzle';
import { app_min_versions } from '@kilocode/db/schema';
import { FAILURE_BACKOFF_MS } from '@kilocode/web-shared/lib/cached-fetch';
import { UpstreamApiError } from '@kilocode/web-shared/lib/trpc/transport';
import { isVersionBelow } from '@kilocode/app-shared/app-version';

export type MinimumVersionHeaders = { get(name: string): string | null };
export type MinimumVersions = { ios: string; android: string };

const CACHE_TTL_MS = 5 * 60 * 1000;
// A "no row" read is a fail-closed verdict, so it must not outlive a fix to the
// configuration by the full TTL. One re-read per window still keeps the SELECT
// off every mobile request.
const NO_ROW_CACHE_TTL_MS = 30 * 1000;
// The gate runs in front of every mobile procedure, so a read that never settles
// must not be awaited by all of them for their whole budget. Bound how long a
// caller waits; the single read keeps its connection and is never duplicated.
const READ_WAIT_MS = 5_000;
const VERSION_PATTERN = /^\d+(\.\d+)*$/;

type CachedMinimumVersions = {
  /** `null` when the table holds no row; cached like any other successful read. */
  versions: MinimumVersions | null;
  fetchedAt: number;
};

let cache: CachedMinimumVersions | null = null;
/** Earliest time at which a failed read, or another wait, may be retried. */
let nextRetryAt = 0;
/**
 * The one read allowed at a time. It never rejects, and clears itself when it
 * settles, so a read that outlives a caller's wait cannot be joined by a second
 * one and cannot accumulate pool connections.
 */
let readInFlight: Promise<void> | null = null;

export function isMobileClient(headersList?: MinimumVersionHeaders | null): boolean {
  return headersList?.get('x-kilo-client') === 'mobile';
}

/**
 * Enforce the minimum app version for a mobile client. The caller has already
 * confirmed `x-kilo-client === 'mobile'`. Fails closed: an unknown platform,
 * a missing/empty/malformed version, or a version below the minimum all
 * return `{ pass: false }`.
 */
export function enforceMinimumVersion(
  headersList: MinimumVersionHeaders | null | undefined,
  minimums: MinimumVersions
): { pass: boolean } {
  if (!headersList) {
    return { pass: false };
  }
  const platform = headersList.get('x-kilo-app-platform');
  if (platform !== 'ios' && platform !== 'android') {
    return { pass: false };
  }
  const version = headersList.get('x-kilo-app-version');
  if (!version || !VERSION_PATTERN.test(version)) {
    return { pass: false };
  }
  const platformMinimum = platform === 'ios' ? minimums.ios : minimums.android;
  if (isVersionBelow(version, platformMinimum)) {
    return { pass: false };
  }
  return { pass: true };
}

/**
 * Update the cache from one read, or record its failure. The backoff is set
 * before the report so a throwing reporter cannot leave a stuck window.
 */
async function runRead(): Promise<void> {
  try {
    const rows = await readDb
      .select({
        ios: app_min_versions.ios_min_version,
        android: app_min_versions.android_min_version,
      })
      .from(app_min_versions)
      .limit(1);
    cache = {
      versions: rows.length === 0 ? null : { ios: rows[0].ios, android: rows[0].android },
      fetchedAt: Date.now(),
    };
    nextRetryAt = 0;
  } catch (error) {
    // One report per attempt, and the backoff below suppresses every attempt
    // inside the window, so an outage is reported at most once per window.
    nextRetryAt = Date.now() + FAILURE_BACKOFF_MS;
    captureException(error);
  }
}

/** Start the read, or join the one already running. */
function ensureRead(): Promise<void> {
  if (!readInFlight) {
    readInFlight = runRead()
      .catch(() => undefined)
      .finally(() => {
        readInFlight = null;
      });
  }
  return readInFlight;
}

/**
 * Wait for the read, but no longer than `READ_WAIT_MS`. Resolves `false` when
 * the wait expired with the read still running: the caller stops waiting while
 * the read keeps its connection, and `ensureRead` refuses to start another.
 */
function waitForRead(read: Promise<void>): Promise<boolean> {
  const { promise, resolve } = Promise.withResolvers<boolean>();
  const timer = setTimeout(() => {
    resolve(false);
  }, READ_WAIT_MS);
  // `ensureRead` never rejects, so there is no rejection to observe here.
  void read.then(() => {
    clearTimeout(timer);
    resolve(true);
  });
  return promise;
}

/**
 * Read the configured minimum versions with an in-process cache.
 *
 * A successful read is cached — for `CACHE_TTL_MS` when it returned a row, and
 * for the shorter `NO_ROW_CACHE_TTL_MS` when it found none, so a fail-closed
 * verdict follows a configuration fix quickly. At most one read runs at a time
 * and every caller joins it, so a cold instance or an expired entry never
 * issues more than one `SELECT`, and a read that outlives a caller's wait is
 * never duplicated. A failed read is negatively cached for `FAILURE_BACKOFF_MS`:
 * callers get the last-known value without awaiting a read that is already
 * failing, and neither a failure nor an expired wait is retried inside the
 * window.
 *
 * Resolves `null` only when the last successful read found no row. When nothing
 * is cached and the read fails or does not answer in time, it rejects with
 * `minimumVersionUnavailableError()` — a retryable `SERVICE_UNAVAILABLE` — so an
 * infrastructure failure is never reported to a client as a required app update.
 */
export async function getMinimumVersions(): Promise<MinimumVersions | null> {
  const now = Date.now();
  if (cache && now - cache.fetchedAt < (cache.versions ? CACHE_TTL_MS : NO_ROW_CACHE_TTL_MS)) {
    return cache.versions;
  }
  if (now < nextRetryAt) {
    if (cache) {
      return cache.versions;
    }
    throw minimumVersionUnavailableError();
  }
  const settled = await waitForRead(ensureRead());
  if (!settled) {
    nextRetryAt = Date.now() + FAILURE_BACKOFF_MS;
  }
  if (cache) {
    return cache.versions;
  }
  throw minimumVersionUnavailableError();
}

/**
 * Retryable failure of the `app_min_versions` read. Deliberately carries no
 * `app_update_required` cause, so the mobile client retries the call instead of
 * entering its forced-update state. The underlying error is reported to Sentry
 * by the read that failed.
 */
export function minimumVersionUnavailableError(): TRPCError {
  return new TRPCError({
    code: 'SERVICE_UNAVAILABLE',
    message: 'App version check temporarily unavailable',
  });
}

export function appUpdateRequiredError(): TRPCError {
  return new TRPCError({
    code: 'FORBIDDEN',
    message: 'App update required',
    cause: new UpstreamApiError('app_update_required'),
  });
}
