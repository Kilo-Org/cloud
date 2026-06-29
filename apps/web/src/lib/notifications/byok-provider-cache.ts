import * as z from 'zod';

import { posthogQuery } from '@/lib/posthog-query';
import { redisClient } from '@/lib/redis';
import { byokProvidersNotificationRedisKey } from '@/lib/redis-keys';

/**
 * Backing store for the "Try BYOK for Kilo Gateway" notification.
 *
 * A daily cron (`/api/cron/sync-byok-provider-notifications`) runs the PostHog
 * query once and writes one small Redis entry per user — the array of BYOK
 * provider ids that user has used. When notifications are polled we read only
 * that user's entry, instead of fetching the full ~700KB dataset and scanning
 * it on every request (which degraded badly on Vercel where the in-process
 * cache rarely survives between invocations).
 */

// 7 days, comfortably longer than the daily cron cadence so a few missed runs
// degrade to "no notification" rather than serving nothing.
const REDIS_TTL_SECONDS = 60 * 60 * 24 * 7;

// Upstash REST has no native MSET-with-TTL; batch SETs into pipelines to avoid
// one HTTP round-trip per user when writing the full dataset.
const REDIS_WRITE_CHUNK_SIZE = 1000;

const BYOK_PROVIDER_QUERY =
  'select id, apiProvider from notification_byok_providers_jan_19 limit 5e5';

const byokProviderRowsSchema = z.array(
  z.tuple([z.string(), z.string()]).transform(([userId, provider]) => ({ userId, provider }))
);

const cachedProvidersSchema = z.array(z.string());

export type ByokProviderRow = { userId: string; provider: string };
export type ByokProviderRowsFetcher = () => Promise<ByokProviderRow[]>;

const fetchByokProviderRowsFromPosthog: ByokProviderRowsFetcher = async () => {
  const response = await posthogQuery('sync-byok-provider-notifications', BYOK_PROVIDER_QUERY);
  if (response.status !== 'ok') {
    throw new Error(`PostHog query failed: ${JSON.stringify(response.error)}`);
  }

  const parsed = byokProviderRowsSchema.safeParse(response.body.results ?? []);
  if (!parsed.success) {
    throw new Error(`Failed to parse BYOK provider rows: ${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
};

export function groupProvidersByUser(rows: ByokProviderRow[]): Map<string, string[]> {
  const byUser = new Map<string, string[]>();
  for (const { userId, provider } of rows) {
    const existing = byUser.get(userId);
    if (existing) {
      if (!existing.includes(provider)) existing.push(provider);
    } else {
      byUser.set(userId, [provider]);
    }
  }
  return byUser;
}

export type SyncByokProviderNotificationsResult = {
  rowCount: number;
  userCount: number;
};

/**
 * Runs the PostHog query and writes per-user provider arrays to Redis.
 *
 * The PostHog fetcher is injectable so this can be exercised without hitting
 * the external query API.
 */
export async function syncByokProviderNotificationsToRedis(
  fetchRows: ByokProviderRowsFetcher = fetchByokProviderRowsFromPosthog
): Promise<SyncByokProviderNotificationsResult> {
  const rows = await fetchRows();
  const byUser = groupProvidersByUser(rows);

  const entries = [...byUser.entries()];
  for (let i = 0; i < entries.length; i += REDIS_WRITE_CHUNK_SIZE) {
    const chunk = entries.slice(i, i + REDIS_WRITE_CHUNK_SIZE);
    const pipeline = redisClient.pipeline();
    for (const [userId, providers] of chunk) {
      pipeline.set(byokProvidersNotificationRedisKey(userId), JSON.stringify(providers), {
        ex: REDIS_TTL_SECONDS,
      });
    }
    await pipeline.exec();
  }

  return { rowCount: rows.length, userCount: byUser.size };
}

/**
 * Reads the BYOK provider ids cached for a single user. Returns an empty array
 * when there is no entry (the common case) or when the cached value is
 * malformed, so callers fail open and simply skip the notification.
 */
export async function getByokProvidersForUser(userId: string): Promise<string[]> {
  const cached = await redisClient.get<string>(byokProvidersNotificationRedisKey(userId));
  if (cached === null) return [];

  try {
    const parsed = cachedProvidersSchema.safeParse(JSON.parse(cached));
    return parsed.success ? parsed.data : [];
  } catch {
    return [];
  }
}
