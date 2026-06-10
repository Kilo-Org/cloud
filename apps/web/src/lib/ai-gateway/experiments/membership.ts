import { redisClient } from '@/lib/redis';
import { EXPERIMENTED_PUBLIC_IDS_REDIS_KEY } from '@/lib/redis-keys';
import { createCachedFetch } from '@/lib/cached-fetch';

/**
 * Membership pre-check for model-experiment routing. Lives in its own module
 * (separate from `pick-variant.ts`) so it can be imported from
 * `lib/ai-gateway/models.ts` — which is reachable from client bundles —
 * without dragging in `pick-variant.ts`'s drizzle dependency.
 *
 * Touches only Redis + an in-process cache. Admin writes are responsible for
 * maintaining the Redis membership set; if Redis is empty, corrupt, or
 * unavailable, treat it as "no experimented public ids".
 */
const EXPERIMENTED_PUBLIC_IDS_LOCAL_CACHE_TTL_MS = process.env.NODE_ENV === 'test' ? 0 : 60_000;

const getExperimentedPublicIds = createCachedFetch<string[]>(
  async () => {
    try {
      const cached = await redisClient.get<string>(EXPERIMENTED_PUBLIC_IDS_REDIS_KEY);
      if (cached === null) return [];
      return parseStringArray(cached) ?? [];
    } catch {
      // captureException already invoked by the redis helper
      return [];
    }
  },
  EXPERIMENTED_PUBLIC_IDS_LOCAL_CACHE_TTL_MS,
  []
);

/**
 * Fast pre-check: does any active|paused experiment target this public id?
 *
 * Reads from a short-lived in-process cache backed by Redis.
 */
export async function isPublicIdExperimented(publicId: string): Promise<boolean> {
  const ids = await getExperimentedPublicIds();
  return ids.includes(publicId);
}

function parseStringArray(raw: string): string[] | null {
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    if (parsed.some(v => typeof v !== 'string')) return null;
    return parsed as string[];
  } catch {
    return null;
  }
}
