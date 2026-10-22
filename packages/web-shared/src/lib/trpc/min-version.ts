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
// would be awaited by all of them. Bound it well inside the mobile control-plane
// budget and treat the timeout as a failed read.
const READ_TIMEOUT_MS = 5_000;
const VERSION_PATTERN = /^\d+(\.\d+)*$/;

type CachedMinimumVersions = {
  /** `null` when the table holds no row; cached like any other successful read. */
  versions: MinimumVersions | null;
  fetchedAt: number;
};

let cache: CachedMinimumVersions | null = null;
/** Earliest time at which a failed read may be attempted again. */
let nextRetryAt = 0;
/** Shared refresh, so concurrent callers never issue more than one SELECT. */
let inFlight: Promise<MinimumVersions | null> | null = null;

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
 * Bound one read. The underlying query keeps running; its result is ignored and
 * its rejection is already handled, so a late settle never becomes unhandled.
 */
function withReadTimeout<T>(read: PromiseLike<T>): Promise<T> {
  const query = Promise.resolve(read);
  const { promise, resolve, reject } = Promise.withResolvers<T>();
  const timer = setTimeout(() => {
    reject(new Error(`app_min_versions read timed out after ${READ_TIMEOUT_MS}ms`));
  }, READ_TIMEOUT_MS);
  query.then(
    value => {
      clearTimeout(timer);
      resolve(value);
    },
    (error: unknown) => {
      clearTimeout(timer);
      reject(error);
    }
  );
  return promise;
}

async function readMinimumVersions(): Promise<MinimumVersions | null> {
  try {
    const rows = await withReadTimeout(
      readDb
        .select({
          ios: app_min_versions.ios_min_version,
          android: app_min_versions.android_min_version,
        })
        .from(app_min_versions)
        .limit(1)
    );
    const versions = rows.length === 0 ? null : { ios: rows[0].ios, android: rows[0].android };
    cache = { versions, fetchedAt: Date.now() };
    nextRetryAt = 0;
    return versions;
  } catch (error) {
    // One report per attempt, and the backoff below suppresses every attempt
    // inside the window, so an outage is reported at most once per window.
    captureException(error);
    nextRetryAt = Date.now() + FAILURE_BACKOFF_MS;
    if (cache) {
      return cache.versions;
    }
    throw minimumVersionUnavailableError();
  }
}

/**
 * Read the configured minimum versions with an in-process cache.
 *
 * A successful read is cached — for `CACHE_TTL_MS` when it returned a row, and
 * for the shorter `NO_ROW_CACHE_TTL_MS` when it found none, so a fail-closed
 * verdict follows a configuration fix quickly — and callers that arrive while a
 * refresh is in flight share it. A read is bounded by `READ_TIMEOUT_MS`, and a
 * failed or timed-out read is negatively cached for `FAILURE_BACKOFF_MS`:
 * callers get the last-known value without awaiting a read that is already
 * failing, and no new read is attempted until the window passes.
 *
 * Resolves `null` only when the last successful read found no row. A read that
 * fails with nothing cached rejects with `minimumVersionUnavailableError()` — a
 * retryable `SERVICE_UNAVAILABLE` — so an infrastructure failure is never
 * reported to a client as a required app update.
 */
export async function getMinimumVersions(): Promise<MinimumVersions | null> {
  const now = Date.now();
  if (cache && now - cache.fetchedAt < (cache.versions ? CACHE_TTL_MS : NO_ROW_CACHE_TTL_MS)) {
    return cache.versions;
  }
  if (cache && now < nextRetryAt) {
    return cache.versions;
  }
  if (inFlight) {
    return inFlight;
  }
  if (now < nextRetryAt) {
    throw minimumVersionUnavailableError();
  }
  const refresh = readMinimumVersions();
  inFlight = refresh;
  try {
    return await refresh;
  } finally {
    inFlight = null;
  }
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
