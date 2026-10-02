import { isClaudeModel } from '@/lib/ai-gateway/providers/anthropic.constants';
import { isOpenAiModel } from '@/lib/ai-gateway/providers/openai';
import { isAnonymousUserId } from '@/lib/anonymous';
import { redisClient } from '@/lib/redis';
import { refusalCooldownRedisKey, refusalCountRedisKey } from '@/lib/redis-keys';

/** Refusals within one counting window that start a cooldown. */
export const REFUSAL_COOLDOWN_THRESHOLD = 5;
/** The counting window starts at the first refusal it counts. */
export const REFUSAL_COUNT_WINDOW_SECONDS = 60 * 60;
export const REFUSAL_COOLDOWN_SECONDS = 60 * 60;

/**
 * Refusals are counted, and the cooldown enforced, only for personal requests
 * to Claude and GPT models. Organization requests are excluded for now.
 */
export function isRefusalCooldownSubject(subject: {
  kiloUserId: string;
  organizationId: string | null | undefined;
  model: string;
}): boolean {
  return (
    !subject.organizationId &&
    !isAnonymousUserId(subject.kiloUserId) &&
    (isClaudeModel(subject.model) || isOpenAiModel(subject.model))
  );
}

/**
 * Returns when the user's refusal cooldown ends, or null when none is active.
 * Fails open: a Redis failure must not block requests.
 */
export async function getRefusalCooldownExpiry(kiloUserId: string): Promise<Date | null> {
  try {
    const value = await redisClient.get<string>(refusalCooldownRedisKey(kiloUserId));
    if (!value) return null;
    const expiresAt = new Date(value);
    if (Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() <= Date.now()) return null;
    return expiresAt;
  } catch (error) {
    console.error('Failed to read refusal cooldown', { kiloUserId, error });
    return null;
  }
}

/** Counts one refusal and starts a cooldown once the threshold is reached. Never throws. */
export async function recordRefusal(kiloUserId: string): Promise<void> {
  try {
    const countKey = refusalCountRedisKey(kiloUserId);
    const count = await redisClient.incr(countKey);
    // NX anchors the window at its first refusal, and also repairs a counter
    // whose earlier expire call failed.
    await redisClient.expire(countKey, REFUSAL_COUNT_WINDOW_SECONDS, 'NX');
    if (count < REFUSAL_COOLDOWN_THRESHOLD) return;

    const expiresAt = new Date(Date.now() + REFUSAL_COOLDOWN_SECONDS * 1000);
    // NX keeps refusals from requests that were already in flight from
    // extending a running cooldown.
    const started = await redisClient.set(
      refusalCooldownRedisKey(kiloUserId),
      expiresAt.toISOString(),
      { ex: REFUSAL_COOLDOWN_SECONDS, nx: true }
    );
    await redisClient.del(countKey);
    if (started) {
      console.warn('Refusal cooldown started', {
        kiloUserId,
        refusals: count,
        expiresAt: expiresAt.toISOString(),
      });
    }
  } catch (error) {
    console.error('Failed to record refusal', { kiloUserId, error });
  }
}
