import { createHash } from 'crypto';
import { after } from 'next/server';
import { redisClient } from '@kilocode/web-shared/lib/redis';
import { partnerUpstreamErrorRedisKey } from '@kilocode/web-shared/lib/redis-keys';
import { claimReportWindow } from '@kilocode/web-shared/lib/ai-gateway/report-window';
import type { GatewayRequest } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/types';

/**
 * How long a session keeps passing over a partner after the partner's upstream failed for it. Each
 * request of the session that passes over the partner, or sees it fail again, restarts the window.
 */
export const PARTNER_UPSTREAM_ERROR_TTL_SECONDS = 5 * 60;

/** One caller's session with one partner, identified by the request's prompt cache key. */
export type PartnerSession = { userId: string; partnerId: string; promptCacheKey: string };

/**
 * The session of a request that is sent with a prompt cache key, or null without one. Routing runs
 * before `applyTrackingIds` derives the upstream key from the task id, so this follows the same
 * precedence: the task id, then the client's own `prompt_cache_key`.
 */
export function getPartnerSession(
  request: GatewayRequest,
  taskId: string | null | undefined,
  userId: string,
  partnerId: string
): PartnerSession | null {
  if (request.kind === 'messages') return null;
  const clientKey = request.body.prompt_cache_key;
  const promptCacheKey = taskId || (typeof clientKey === 'string' ? clientKey : '');
  if (!promptCacheKey) return null;
  return { userId, partnerId, promptCacheKey };
}

/** Hashing keeps the caller and the client's prompt cache key out of Redis keys. */
function cacheKey(session: PartnerSession) {
  const digest = createHash('sha256')
    .update(JSON.stringify([session.userId, session.partnerId, session.promptCacheKey]))
    .digest('hex');
  return partnerUpstreamErrorRedisKey(digest);
}

// Only the error name is logged: a Redis error message can echo the command arguments. Each
// operation reports once per window, so an outage cannot add log lines to every inference.
function warn(operation: 'read' | 'write', error: unknown): void {
  if (!claimReportWindow(`partner-upstream-error-cache:${operation}`, Date.now())) return;
  console.warn(
    `[partner-upstream-error-cache] ${operation} failed`,
    error instanceof Error ? error.name : 'unknown'
  );
}

/**
 * Remembers, or keeps remembering, that the partner failed for the session. Redis writes go to the
 * Frankfurt primary, so the write runs after the response and never delays inference.
 */
export function rememberPartnerUpstreamError(session: PartnerSession): void {
  const key = cacheKey(session);
  try {
    after(async () => {
      try {
        await redisClient.set(key, '1', { ex: PARTNER_UPSTREAM_ERROR_TTL_SECONDS });
      } catch (error) {
        warn('write', error);
      }
    });
  } catch (error) {
    // `after()` throws outside a request scope; the cache never fails the request.
    warn('write', error);
  }
}

/**
 * Whether the partner failed for the session recently; a hit restarts the window. Best effort: the
 * read uses the local Redis replica, whose lag may miss a recent failure, and Redis trouble is a
 * miss, so the partner is tried as usual.
 */
export async function hasRecentPartnerUpstreamError(session: PartnerSession): Promise<boolean> {
  let hit: boolean;
  try {
    hit = (await redisClient.exists(cacheKey(session))) > 0;
  } catch (error) {
    warn('read', error);
    return false;
  }
  if (hit) rememberPartnerUpstreamError(session);
  return hit;
}
