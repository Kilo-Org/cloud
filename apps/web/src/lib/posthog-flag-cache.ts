/**
 * Redis-backed cache for PostHog feature flag definitions.
 *
 * In a multi-instance deployment (e.g. multiple Next.js server processes), we want
 * only ONE instance to poll PostHog for flag updates while all instances share the
 * cached results, avoiding redundant API calls.
 *
 * This uses a distributed lock pattern:
 *   - One instance acquires the lock and fetches flag definitions
 *   - Others skip fetching and read from the shared Redis cache
 *   - The lock is released after storing data so the next poll cycle re-elects
 *   - If the fetching instance crashes, the lock TTL ensures another takes over
 *
 * When Redis is unavailable, all instances fall through to PostHog API calls
 * (the same behaviour as before this cache was added).
 *
 * Reference: https://posthog.com/docs/feature-flags/local-evaluation/distributed-environments
 */

import type {
  FlagDefinitionCacheProvider,
  FlagDefinitionCacheData,
} from 'posthog-node/experimental';
import { redisGet, redisSet, redisSetNX, redisDel } from '@/lib/redis';
import {
  POSTHOG_FLAG_DEFINITIONS_REDIS_KEY,
  POSTHOG_FLAG_CACHE_LOCK_REDIS_KEY,
} from '@/lib/redis-keys';

const LOCK_TTL_SECONDS = 90; // longer than the default 30s polling interval
const CACHE_TTL_SECONDS = 60 * 60 * 24; // 24 hours; flags are also held in memory

export function createPostHogFlagCache(): FlagDefinitionCacheProvider {
  return {
    async getFlagDefinitions(): Promise<FlagDefinitionCacheData | undefined> {
      const cached = await redisGet(POSTHOG_FLAG_DEFINITIONS_REDIS_KEY);
      return cached ? (JSON.parse(cached) as FlagDefinitionCacheData) : undefined;
    },

    async shouldFetchFlagDefinitions(): Promise<boolean> {
      // Try to acquire the lock. Returns false if Redis is unavailable (fail open:
      // every instance will then fall back to fetching independently).
      try {
        return await redisSetNX(POSTHOG_FLAG_CACHE_LOCK_REDIS_KEY, '1', LOCK_TTL_SECONDS);
      } catch {
        // Redis unavailable – let this instance fetch so flag evaluation is not broken.
        return true;
      }
    },

    async onFlagDefinitionsReceived(data: FlagDefinitionCacheData): Promise<void> {
      await redisSet(POSTHOG_FLAG_DEFINITIONS_REDIS_KEY, JSON.stringify(data), CACHE_TTL_SECONDS);
      // Release the lock so the next poll cycle can re-elect a leader.
      await redisDel(POSTHOG_FLAG_CACHE_LOCK_REDIS_KEY);
    },

    async shutdown(): Promise<void> {
      // Best-effort lock release on graceful shutdown; ignore errors.
      try {
        await redisDel(POSTHOG_FLAG_CACHE_LOCK_REDIS_KEY);
      } catch {
        // intentionally ignored
      }
    },
  };
}
