import { db } from '@/lib/drizzle';
import { free_model_usage } from '@/db/schema';
import { and, count, gte, sql } from 'drizzle-orm';
import {
  FREE_MODEL_RATE_LIMIT_WINDOW_HOURS,
  FREE_MODEL_MAX_REQUESTS_PER_WINDOW,
  TIME_WINDOW_PROMOTION_MODELS_USAGE_WITHOUT_ACCOUNT_HOURS,
  MAX_PROMPTS_ON_PROMOTION_MODELS_WITHOUT_ACCOUNT,
} from '@/lib/constants';

export type RateLimitResult = {
  allowed: boolean;
  requestCount: number;
};

async function getModelUsageSinceTime(windowStart: Date, ipAddress: string): Promise<number> {
  const usage = await db
    .select({
      totalRequests: count(),
    })
    .from(free_model_usage)
    .where(
      and(
        sql`${free_model_usage.ip_address} = ${ipAddress}`,
        gte(free_model_usage.created_at, windowStart.toISOString())
      )
    );

  const requestCount = Number(usage[0]?.totalRequests ?? 0);

  return requestCount;
}

/**
 * Check if an IP address is within the free model rate limit.
 * This applies to ALL free model requests, both anonymous and authenticated.
 */
export async function checkFreeModelRateLimit(ipAddress: string): Promise<RateLimitResult> {
  const windowStart = new Date(Date.now() - FREE_MODEL_RATE_LIMIT_WINDOW_HOURS * 60 * 60 * 1000);

  const requestCount = await getModelUsageSinceTime(windowStart, ipAddress);

  return {
    allowed: requestCount < FREE_MODEL_MAX_REQUESTS_PER_WINDOW,
    requestCount,
  };
}

/**
 * Check if an IP address is within the promotion limit.
 * Applies to free model requests without authentication.
 */
export async function checkPromotionLimit(ipAddress: string): Promise<RateLimitResult> {
  const windowStart = new Date(
    Date.now() - TIME_WINDOW_PROMOTION_MODELS_USAGE_WITHOUT_ACCOUNT_HOURS * 60 * 60 * 1000
  );

  const requestCount = await getModelUsageSinceTime(windowStart, ipAddress);

  return {
    allowed: requestCount < MAX_PROMPTS_ON_PROMOTION_MODELS_WITHOUT_ACCOUNT,
    requestCount,
  };
}

/**
 * Log a free model request for rate limiting purposes.
 * This should be called at the START of the request, before processing.
 */
export async function logFreeModelRequest(
  ipAddress: string,
  model: string,
  kiloUserId?: string
): Promise<void> {
  await db.insert(free_model_usage).values({
    ip_address: ipAddress,
    model,
    kilo_user_id: kiloUserId,
  });
}
