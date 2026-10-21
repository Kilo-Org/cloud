import { redisClient } from '@kilocode/web-shared/lib/redis';

export type SessionStartRateLimitInput = {
  /** Namespace for this flow, so each flow keeps its own budget. */
  keyPrefix: string;
  /** Owner the session starts for: an organization id, or `personal`. */
  ownerScope: string;
  /** Acting user id. */
  userId: string;
  /** Requests allowed per window. */
  limit: number;
  /** Window length in seconds. */
  windowSeconds: number;
};

/**
 * Per-actor cap for flows that start a credit-spending cloud agent session: a Redis fixed window
 * keyed by the acting USER (scoped by org, so members keep separate budgets) and by the window
 * bucket. Embedding the bucket in the key makes the window self-healing: even if `expire` fails
 * after `incr`, the key rotates on the next window rather than counting up forever. Fails OPEN on
 * any Redis error (per redis.ts guidance).
 *
 * Callers MUST invoke this only after access to the target is proven, so each counter is only
 * ever charged for the acting user's own scope.
 */
export async function isSessionStartRateLimited({
  keyPrefix,
  ownerScope,
  userId,
  limit,
  windowSeconds,
}: SessionStartRateLimitInput): Promise<boolean> {
  try {
    const windowMs = windowSeconds * 1000;
    const bucket = Math.floor(Date.now() / windowMs);
    const key = `${keyPrefix}:${ownerScope}:${userId}:${bucket}`;
    const count = await redisClient.incr(key);
    if (count === 1) {
      // Best-effort TTL cleanup; correctness does not depend on it (the key rotates per window).
      await redisClient.expire(key, windowSeconds * 2);
    }
    return count > limit;
  } catch {
    return false;
  }
}
