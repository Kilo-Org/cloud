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
// caller waits; a read still running after that keeps its connection.
const READ_WAIT_MS = 5_000;
// A read older than this is abandoned: a later caller may start another one, so
// a query that never settles cannot keep the gate from reading the table again.
const READ_MAX_AGE_MS = 15_000;
// An abandoned read holds its pool connection until it settles, so bound how
// many reads one stuck database can pin.
const MAX_LIVE_READS = 2;
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
 * The read later callers join. It never rejects, and is released when it
 * settles or when it is older than `READ_MAX_AGE_MS`, so a read that outlives
 * a caller's wait is neither duplicated on every request nor kept forever.
 */
let readInFlight: Promise<void> | null = null;
/** When `readInFlight` started. */
let readStartedAt = 0;
/** Identifies the current read, so a settled abandoned read releases no newer one. */
let readGeneration = 0;
/** Reads still running, including abandoned ones that hold a pool connection. */
let liveReads = 0;

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

/**
 * Join the current read, or start one. Returns `null` when the current read is
 * too old to join and the live-read budget is spent: the caller answers without
 * waiting on a read that may never settle, and without pinning another
 * connection to a database that is already stuck.
 */
function ensureRead(now: number): Promise<void> | null {
  if (readInFlight && now - readStartedAt < READ_MAX_AGE_MS) {
    return readInFlight;
  }
  if (liveReads >= MAX_LIVE_READS) {
    return null;
  }
  const generation = (readGeneration += 1);
  readStartedAt = now;
  liveReads += 1;
  const read = runRead()
    .catch(() => undefined)
    .finally(() => {
      liveReads -= 1;
      // A superseded read must not release the slot of the one replacing it.
      if (readGeneration === generation) {
        readInFlight = null;
      }
    });
  readInFlight = read;
  return read;
}

/**
 * Wait for the read, but no longer than `READ_WAIT_MS`. Resolves `false` when
 * the wait expired with the read still running: the caller stops waiting while
 * the read keeps its connection.
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
 * verdict follows a configuration fix quickly. Callers share one read at a
 * time, so a cold instance or an expired entry never issues more than one
 * `SELECT`. A read that runs past `READ_MAX_AGE_MS` is abandoned rather than
 * joined, so one query that never settles cannot keep the gate from reading the
 * table again; abandoned reads still count against `MAX_LIVE_READS` so they
 * cannot pin an unbounded number of pool connections. A failed read is
 * negatively cached for `FAILURE_BACKOFF_MS`: callers get the last-known value
 * without awaiting a read that is already failing, and neither a failure nor an
 * expired wait is retried inside the window.
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
  const read = ensureRead(now);
  const settled = read ? await waitForRead(read) : false;
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
