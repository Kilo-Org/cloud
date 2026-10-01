import { TRPCError } from '@trpc/server';
import { captureException } from '@sentry/nextjs';

import { readDb } from '@/lib/drizzle';
import { app_min_versions } from '@kilocode/db/schema';
import { UpstreamApiError } from '@/lib/trpc/transport';
import { isVersionBelow } from '@kilocode/app-shared/app-version';

export type MinimumVersionHeaders = { get(name: string): string | null };
export type MinimumVersions = { ios: string; android: string };

const CACHE_TTL_MS = 5 * 60 * 1000;
const VERSION_PATTERN = /^\d+(\.\d+)*$/;

let cache: (MinimumVersions & { fetchedAt: number }) | null = null;

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
 * Read the configured minimum versions with a 5-minute in-process cache.
 * Returns `null` when no row is configured (not cached) or when a read fails
 * with no cached value — the fail-closed policy. On a read failure with a
 * cached value, the stale cache is returned.
 */
export async function getMinimumVersions(): Promise<MinimumVersions | null> {
  if (cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) {
    return { ios: cache.ios, android: cache.android };
  }
  try {
    const rows = await readDb
      .select({
        ios: app_min_versions.ios_min_version,
        android: app_min_versions.android_min_version,
      })
      .from(app_min_versions)
      .limit(1);
    if (rows.length === 0) {
      return null;
    }
    cache = { ios: rows[0].ios, android: rows[0].android, fetchedAt: Date.now() };
    return { ios: cache.ios, android: cache.android };
  } catch (error) {
    captureException(error);
    if (cache) {
      return { ios: cache.ios, android: cache.android };
    }
    return null;
  }
}

export function appUpdateRequiredError(): TRPCError {
  return new TRPCError({
    code: 'FORBIDDEN',
    message: 'App update required',
    cause: new UpstreamApiError('app_update_required'),
  });
}
