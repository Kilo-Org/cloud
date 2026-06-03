import { createClient } from 'redis';
import { captureException } from '@sentry/nextjs';
import type { RedisKey } from '@/lib/redis-keys';

type RedisClient = ReturnType<typeof createClient>;
type RedisOperation = 'get' | 'getdel' | 'set' | 'del';
type RedisTimeoutPhase = 'connect' | 'command';

// TCP handshake + TLS negotiation can take a moment on a cold connection.
// Redis official docs recommend 1-3s for connect (redis.io/docs/latest/develop/clients).
const CONNECT_TIMEOUT_MS = 1_500;

// Simple GET/SET commands complete in sub-millisecond; anything over 200ms
// means Redis is overloaded or unreachable and we should fail open.
const COMMAND_TIMEOUT_MS = 200;

let client: RedisClient | null = null;
let connectPromise: Promise<unknown> | null = null;

class RedisTimeoutError extends Error {
  constructor(
    readonly redisTimeoutPhase: RedisTimeoutPhase,
    readonly redisTimeoutMs: number
  ) {
    super(`Redis timeout (${redisTimeoutPhase})`);
    this.name = 'RedisTimeoutError';
  }
}

function captureRedisOperationException(
  err: unknown,
  operation: RedisOperation,
  key: RedisKey,
  c: RedisClient
) {
  const timeoutPhase = err instanceof RedisTimeoutError ? err.redisTimeoutPhase : undefined;
  captureException(err, {
    tags: {
      service: 'redis',
      operation,
      ...(timeoutPhase ? { redis_timeout_phase: timeoutPhase } : {}),
    },
    extra: {
      key,
      client_is_open: c.isOpen,
      client_is_ready: c.isReady,
      redis_timeout_ms: err instanceof RedisTimeoutError ? err.redisTimeoutMs : undefined,
    },
  });
}

function getOrCreateClient(): RedisClient | null {
  if (!process.env.REDIS_URL) {
    return null;
  }
  if (!client) {
    client = createClient({
      url: process.env.REDIS_URL,
      socket: { connectTimeout: CONNECT_TIMEOUT_MS },
    });
    client.on('error', err => {
      captureException(err, { tags: { service: 'redis' } });
    });
  }
  return client;
}

async function ensureConnected(c: RedisClient): Promise<RedisClient> {
  if (c.isReady) return c;
  if (!connectPromise) {
    connectPromise = c
      .connect()
      .catch(err => {
        captureException(err, { tags: { service: 'redis', operation: 'connect' } });
        throw err;
      })
      .finally(() => {
        connectPromise = null;
      });
  }
  await connectPromise;
  return c;
}

function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  redisTimeoutPhase: RedisTimeoutPhase
): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new RedisTimeoutError(redisTimeoutPhase, ms)), ms);
    }),
  ]);
}

export async function redisGet(key: RedisKey): Promise<string | null> {
  const c = getOrCreateClient();
  if (!c) return null;
  try {
    await withTimeout(ensureConnected(c), CONNECT_TIMEOUT_MS, 'connect');
    return await withTimeout(c.get(key), COMMAND_TIMEOUT_MS, 'command');
  } catch (err) {
    captureRedisOperationException(err, 'get', key, c);
    throw err;
  }
}

export async function redisGetDel(key: RedisKey): Promise<string | null> {
  const c = getOrCreateClient();
  if (!c) return null;
  try {
    await withTimeout(ensureConnected(c), CONNECT_TIMEOUT_MS, 'connect');
    return await withTimeout(c.getDel(key), COMMAND_TIMEOUT_MS, 'command');
  } catch (err) {
    captureRedisOperationException(err, 'getdel', key, c);
    throw err;
  }
}

/** Returns false if Redis is not configured (REDIS_URL unset). */
export async function redisSet(
  key: RedisKey,
  value: string,
  ttlSeconds?: number
): Promise<boolean> {
  const c = getOrCreateClient();
  if (!c) return false;
  try {
    await withTimeout(ensureConnected(c), CONNECT_TIMEOUT_MS, 'connect');
    if (ttlSeconds) {
      await withTimeout(c.set(key, value, { EX: ttlSeconds }), COMMAND_TIMEOUT_MS, 'command');
    } else {
      await withTimeout(c.set(key, value), COMMAND_TIMEOUT_MS, 'command');
    }
    return true;
  } catch (err) {
    captureRedisOperationException(err, 'set', key, c);
    throw err;
  }
}

/** Returns false if Redis is not configured (REDIS_URL unset). */
export async function redisDel(key: RedisKey): Promise<boolean> {
  const c = getOrCreateClient();
  if (!c) return false;
  try {
    await withTimeout(ensureConnected(c), CONNECT_TIMEOUT_MS, 'connect');
    await withTimeout(c.del(key), COMMAND_TIMEOUT_MS, 'command');
    return true;
  } catch (err) {
    captureRedisOperationException(err, 'del', key, c);
    throw err;
  }
}
