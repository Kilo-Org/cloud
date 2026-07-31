import { randomUUID } from 'node:crypto';
import { captureException } from '@sentry/nextjs';
import {
  FREE_MODEL_RATE_LIMIT_WINDOW_HOURS,
  FREE_MODEL_MAX_REQUESTS_PER_WINDOW,
  PROMOTION_WINDOW_HOURS,
  PROMOTION_MAX_REQUESTS,
} from '@/lib/constants';
import { redisClient } from '@/lib/redis';
import {
  freeModelRateLimitIpRedisKey,
  freeModelRateLimitUserRedisKey,
  promotionRateLimitIpRedisKey,
  type RedisKey,
} from '@/lib/redis-keys';

const MILLISECONDS_PER_HOUR = 60 * 60 * 1000;

const CONSUME_RATE_LIMIT_SCRIPT = `
local time = redis.call('TIME')
local now = time[1] * 1000 + math.floor(time[2] / 1000)
local cutoff = now - tonumber(ARGV[1])

redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', cutoff)

local request_count = redis.call('ZCARD', KEYS[1])
if request_count >= tonumber(ARGV[2]) then
  redis.call('EXPIRE', KEYS[1], tonumber(ARGV[3]))
  return { 0, request_count }
end

redis.call('ZADD', KEYS[1], now, ARGV[4])
redis.call('EXPIRE', KEYS[1], tonumber(ARGV[3]))
return { 1, request_count + 1 }
`;

const GET_RATE_LIMIT_USAGE_SCRIPT = `
local time = redis.call('TIME')
local now = time[1] * 1000 + math.floor(time[2] / 1000)
local cutoff = now - tonumber(ARGV[1])

redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', cutoff)
return redis.call('ZCARD', KEYS[1])
`;

const FILL_RATE_LIMIT_SCRIPT = `
local time = redis.call('TIME')
local now = time[1] * 1000 + math.floor(time[2] / 1000)
local cutoff = now - tonumber(ARGV[1])

redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', cutoff)

local request_count = redis.call('ZCARD', KEYS[1])
local requests_to_add = math.max(0, tonumber(ARGV[2]) - request_count)
for index = 1, requests_to_add do
  redis.call('ZADD', KEYS[1], now, ARGV[4] .. ':' .. index)
end

if requests_to_add > 0 then
  redis.call('EXPIRE', KEYS[1], tonumber(ARGV[3]))
end

return { requests_to_add, request_count + requests_to_add }
`;

export type RateLimitResult = {
  allowed: boolean;
  requestCount: number;
};

type FillRateLimitResult = {
  requestsAdded: number;
  requestCount: number;
};

async function consumeRateLimit(
  key: RedisKey,
  windowHours: number,
  maxRequests: number
): Promise<RateLimitResult> {
  const windowMilliseconds = windowHours * MILLISECONDS_PER_HOUR;
  const windowSeconds = windowHours * 60 * 60;

  try {
    const [allowed, requestCount] = await redisClient.eval<
      [number, number, number, string],
      [number, number]
    >(
      CONSUME_RATE_LIMIT_SCRIPT,
      [key],
      [windowMilliseconds, maxRequests, windowSeconds, randomUUID()]
    );

    return {
      allowed: allowed === 1,
      requestCount,
    };
  } catch (error) {
    captureException(error, { tags: { source: 'free_model_rate_limiter' } });
    // Redis is an availability optimization; do not block inference when it is unavailable.
    return { allowed: true, requestCount: 0 };
  }
}

async function getRateLimitUsage(key: RedisKey, windowHours: number): Promise<number> {
  return redisClient.eval<[number], number>(
    GET_RATE_LIMIT_USAGE_SCRIPT,
    [key],
    [windowHours * MILLISECONDS_PER_HOUR]
  );
}

async function fillRateLimit(
  key: RedisKey,
  windowHours: number,
  maxRequests: number
): Promise<FillRateLimitResult> {
  const [requestsAdded, requestCount] = await redisClient.eval<
    [number, number, number, string],
    [number, number]
  >(
    FILL_RATE_LIMIT_SCRIPT,
    [key],
    [windowHours * MILLISECONDS_PER_HOUR, maxRequests, windowHours * 60 * 60, randomUUID()]
  );

  return { requestsAdded, requestCount };
}

/**
 * Consume one request from an IP address's free model rate limit.
 * This applies to ALL free model requests, both anonymous and authenticated.
 */
export function consumeFreeModelRateLimit(ipAddress: string): Promise<RateLimitResult> {
  return consumeRateLimit(
    freeModelRateLimitIpRedisKey(ipAddress),
    FREE_MODEL_RATE_LIMIT_WINDOW_HOURS,
    FREE_MODEL_MAX_REQUESTS_PER_WINDOW
  );
}

/**
 * Consume one request from a user's free model rate limit.
 * Used for server-side products (cloud-agent, code-review, app-builder)
 * where all requests share infrastructure IPs.
 */
export function consumeFreeModelRateLimitByUser(kiloUserId: string): Promise<RateLimitResult> {
  return consumeRateLimit(
    freeModelRateLimitUserRedisKey(kiloUserId),
    FREE_MODEL_RATE_LIMIT_WINDOW_HOURS,
    FREE_MODEL_MAX_REQUESTS_PER_WINDOW
  );
}

/**
 * Consume one request from an IP address's anonymous promotion limit.
 * Applies to free model requests without authentication.
 */
export function consumePromotionLimit(ipAddress: string): Promise<RateLimitResult> {
  return consumeRateLimit(
    promotionRateLimitIpRedisKey(ipAddress),
    PROMOTION_WINDOW_HOURS,
    PROMOTION_MAX_REQUESTS
  );
}

export function getFreeModelRateLimitUsage(ipAddress: string): Promise<number> {
  return getRateLimitUsage(
    freeModelRateLimitIpRedisKey(ipAddress),
    FREE_MODEL_RATE_LIMIT_WINDOW_HOURS
  );
}

export function fillFreeModelRateLimit(ipAddress: string): Promise<FillRateLimitResult> {
  return fillRateLimit(
    freeModelRateLimitIpRedisKey(ipAddress),
    FREE_MODEL_RATE_LIMIT_WINDOW_HOURS,
    FREE_MODEL_MAX_REQUESTS_PER_WINDOW
  );
}
