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

const CONSUME_ANONYMOUS_RATE_LIMITS_SCRIPT = `
local time = redis.call('TIME')
local now = time[1] * 1000 + math.floor(time[2] / 1000)

redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now - tonumber(ARGV[1]))
redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', now - tonumber(ARGV[4]))

local free_model_count = redis.call('ZCARD', KEYS[1])
local promotion_count = redis.call('ZCARD', KEYS[2])

if free_model_count >= tonumber(ARGV[2]) then
  redis.call('EXPIRE', KEYS[1], tonumber(ARGV[3]))
  redis.call('EXPIRE', KEYS[2], tonumber(ARGV[6]))
  return { 0, free_model_count, promotion_count }
end

if promotion_count >= tonumber(ARGV[5]) then
  redis.call('EXPIRE', KEYS[1], tonumber(ARGV[3]))
  redis.call('EXPIRE', KEYS[2], tonumber(ARGV[6]))
  return { 1, free_model_count, promotion_count }
end

redis.call('ZADD', KEYS[1], now, ARGV[7])
redis.call('ZADD', KEYS[2], now, ARGV[7])
redis.call('EXPIRE', KEYS[1], tonumber(ARGV[3]))
redis.call('EXPIRE', KEYS[2], tonumber(ARGV[6]))
return { 2, free_model_count + 1, promotion_count + 1 }
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

export type AnonymousFreeModelRateLimits = {
  freeModel: RateLimitResult;
  promotion: RateLimitResult;
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
 * Atomically consume the hourly IP and daily promotion limits for an anonymous
 * Kilo free-model request. Neither limit is consumed when either is exhausted.
 */
export async function consumeAnonymousFreeModelRateLimits(
  ipAddress: string
): Promise<AnonymousFreeModelRateLimits> {
  try {
    const [outcome, freeModelCount, promotionCount] = await redisClient.eval<
      [number, number, number, number, number, number, string],
      [number, number, number]
    >(
      CONSUME_ANONYMOUS_RATE_LIMITS_SCRIPT,
      [freeModelRateLimitIpRedisKey(ipAddress), promotionRateLimitIpRedisKey(ipAddress)],
      [
        FREE_MODEL_RATE_LIMIT_WINDOW_HOURS * MILLISECONDS_PER_HOUR,
        FREE_MODEL_MAX_REQUESTS_PER_WINDOW,
        FREE_MODEL_RATE_LIMIT_WINDOW_HOURS * 60 * 60,
        PROMOTION_WINDOW_HOURS * MILLISECONDS_PER_HOUR,
        PROMOTION_MAX_REQUESTS,
        PROMOTION_WINDOW_HOURS * 60 * 60,
        randomUUID(),
      ]
    );

    return {
      freeModel: {
        allowed: outcome !== 0,
        requestCount: freeModelCount,
      },
      promotion: {
        allowed: outcome === 2 || (outcome === 0 && promotionCount < PROMOTION_MAX_REQUESTS),
        requestCount: promotionCount,
      },
    };
  } catch (error) {
    captureException(error, { tags: { source: 'free_model_rate_limiter' } });
    return {
      freeModel: { allowed: true, requestCount: 0 },
      promotion: { allowed: true, requestCount: 0 },
    };
  }
}

/**
 * Check the anonymous promotion limit without consuming it. Third-party free
 * models historically shared the cap but did not add to its request count.
 */
export async function checkPromotionLimit(ipAddress: string): Promise<RateLimitResult> {
  try {
    const requestCount = await getRateLimitUsage(
      promotionRateLimitIpRedisKey(ipAddress),
      PROMOTION_WINDOW_HOURS
    );
    return { allowed: requestCount < PROMOTION_MAX_REQUESTS, requestCount };
  } catch (error) {
    captureException(error, { tags: { source: 'free_model_rate_limiter' } });
    return { allowed: true, requestCount: 0 };
  }
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
