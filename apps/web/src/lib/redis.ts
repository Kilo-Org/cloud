import { Redis } from '@upstash/redis';
import { captureException } from '@sentry/nextjs';
import type { RedisKey } from '@/lib/redis-keys';

type RedisOperation = 'getdel' | 'del';
type RedisConfig = {
  url: string;
  token: string;
  source: 'upstash' | 'vercel-kv';
};

// Simple GET/SET commands should still be fast over REST; anything over 200ms
// means Redis is overloaded or unreachable and callers should fail open.
const COMMAND_TIMEOUT_MS = 200;

let client: Redis | null = null;

export const redisClient = Redis.fromEnv({
  automaticDeserialization: false,
  retry: false,
  signal: () => AbortSignal.timeout(COMMAND_TIMEOUT_MS),
});

class RedisTimeoutError extends Error {
  constructor(readonly redisTimeoutMs: number) {
    super('Redis timeout (command)');
    this.name = 'RedisTimeoutError';
  }
}

function captureRedisOperationException(
  err: unknown,
  operation: RedisOperation,
  key: RedisKey,
  config: RedisConfig
) {
  const timeoutPhase = err instanceof RedisTimeoutError ? 'command' : undefined;
  captureException(err, {
    tags: {
      service: 'redis',
      redis_transport: 'rest',
      redis_config_source: config.source,
      operation,
      ...(timeoutPhase ? { redis_timeout_phase: timeoutPhase } : {}),
    },
    extra: {
      key,
      redis_timeout_ms: err instanceof RedisTimeoutError ? err.redisTimeoutMs : undefined,
    },
  });
}

function getRedisConfig(): RedisConfig | null {
  if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
    return {
      url: process.env.UPSTASH_REDIS_REST_URL,
      token: process.env.UPSTASH_REDIS_REST_TOKEN,
      source: 'upstash',
    };
  }

  if (process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN) {
    return {
      url: process.env.KV_REST_API_URL,
      token: process.env.KV_REST_API_TOKEN,
      source: 'vercel-kv',
    };
  }

  return null;
}

function getOrCreateClient(): { client: Redis; config: RedisConfig } | null {
  const config = getRedisConfig();
  if (!config) {
    return null;
  }
  if (!client) {
    client = new Redis({
      url: config.url,
      token: config.token,
      automaticDeserialization: false,
      retry: false,
    });
  }
  return { client, config };
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise.finally(() => {
      if (timer) clearTimeout(timer);
    }),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new RedisTimeoutError(ms)), ms);
    }),
  ]);
}

export async function redisGetDel(key: RedisKey): Promise<string | null> {
  const redis = getOrCreateClient();
  if (!redis) return null;
  try {
    return await withTimeout(redis.client.getdel<string>(key), COMMAND_TIMEOUT_MS);
  } catch (err) {
    captureRedisOperationException(err, 'getdel', key, redis.config);
    throw err;
  }
}

/** Returns false if Redis is not configured. */
export async function redisDel(key: RedisKey): Promise<boolean> {
  const redis = getOrCreateClient();
  if (!redis) return false;
  try {
    await withTimeout(redis.client.del(key), COMMAND_TIMEOUT_MS);
    return true;
  } catch (err) {
    captureRedisOperationException(err, 'del', key, redis.config);
    throw err;
  }
}
