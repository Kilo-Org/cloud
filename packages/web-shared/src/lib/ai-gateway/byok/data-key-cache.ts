import { createHash } from 'crypto';
import type { BYOKApiKeyEnvelope } from '@kilocode/db/schema-types';
import type { ByokKmsContext } from '@kilocode/web-shared/lib/ai-gateway/byok/kms-context';
import { redisClient } from '@kilocode/web-shared/lib/redis';
import { byokDataKeyRedisKey } from '@kilocode/web-shared/lib/redis-keys';
import { claimReportWindow } from '@kilocode/web-shared/lib/ai-gateway/report-window';

/**
 * How long a decrypted data key may be served without asking the KMS service again. Revoking
 * KMS access to a key therefore takes up to this long to reach inference.
 */
export const BYOK_DATA_KEY_CACHE_TTL_SECONDS = 5 * 60;

/**
 * The cache entry is addressed by everything the KMS service binds a data key to: the wrapped
 * key, the KMS key that wrapped it, and the owner context. A rotated or replaced key stores a
 * new wrapped data key, so a stale entry is never read; it just expires. Hashing keeps
 * identifiers out of Redis keys.
 */
function cacheKey(envelope: BYOKApiKeyEnvelope, context: ByokKmsContext) {
  const digest = createHash('sha256')
    .update(
      JSON.stringify([
        context.key_id,
        context.owner_type,
        context.owner_id,
        context.provider_id,
        envelope.wrapped_dek,
        envelope.kms_key_id,
        envelope.kms_key_version,
      ])
    )
    .digest('hex');
  return byokDataKeyRedisKey(digest);
}

// Only the error name is logged: a Redis error message can echo the command arguments. Each
// operation reports once per window, so an outage cannot add log lines to every inference.
function warn(operation: 'read' | 'write' | 'evict', error: unknown): void {
  if (!claimReportWindow(`byok-data-key-cache:${operation}`, Date.now())) return;
  console.warn(
    `[byok-data-key-cache] ${operation} failed`,
    error instanceof Error ? error.name : 'unknown'
  );
}

/**
 * The cached data key of `envelope`, or null on a miss. Redis trouble is a miss, never an
 * error: the cache is an optimization in front of the KMS service.
 */
export async function getCachedByokDataKey(
  envelope: BYOKApiKeyEnvelope,
  context: ByokKmsContext
): Promise<string | null> {
  try {
    return (await redisClient.get<string>(cacheKey(envelope, context))) || null;
  } catch (error) {
    warn('read', error);
    return null;
  }
}

/** Remembers the data key only. The key it protects is never stored. */
export async function cacheByokDataKey(
  envelope: BYOKApiKeyEnvelope,
  context: ByokKmsContext,
  dataKey: string
): Promise<void> {
  try {
    await redisClient.set(cacheKey(envelope, context), dataKey, {
      ex: BYOK_DATA_KEY_CACHE_TTL_SECONDS,
    });
  } catch (error) {
    warn('write', error);
  }
}

export async function evictCachedByokDataKey(
  envelope: BYOKApiKeyEnvelope,
  context: ByokKmsContext
): Promise<void> {
  try {
    await redisClient.del(cacheKey(envelope, context));
  } catch (error) {
    warn('evict', error);
  }
}
