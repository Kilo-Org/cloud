import type { z } from 'zod';
import { redisClient } from '@kilocode/web-shared/lib/redis';
import { organizationAIAdoptionRedisKey } from '@kilocode/web-shared/lib/redis-keys';

const CACHE_TTL_SECONDS = 60 * 60;

type CacheKeyInput = Parameters<typeof organizationAIAdoptionRedisKey>[0];

/** Redis is only a cache: a failed read or write falls back to the database. */
export async function readCachedAIAdoption<T>(
  input: CacheKeyInput,
  schema: z.ZodType<T>
): Promise<T | null> {
  try {
    const cached = await redisClient.get<string>(organizationAIAdoptionRedisKey(input));
    if (typeof cached !== 'string') return null;
    const parsed = schema.safeParse(JSON.parse(cached));
    return parsed.success ? parsed.data : null;
  } catch (error) {
    console.warn('AI adoption cache read failed', {
      organizationId: input.organizationId,
      error,
    });
    return null;
  }
}

export async function writeCachedAIAdoption(input: CacheKeyInput, value: unknown): Promise<void> {
  try {
    await redisClient.set(organizationAIAdoptionRedisKey(input), JSON.stringify(value), {
      ex: CACHE_TTL_SECONDS,
    });
  } catch (error) {
    console.warn('AI adoption cache write failed', {
      organizationId: input.organizationId,
      error,
    });
  }
}
