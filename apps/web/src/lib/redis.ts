import { createClient } from 'redis';
import { captureException } from '@sentry/nextjs';
import type { RedisKey } from '@/lib/redis-keys';

type RedisClient = ReturnType<typeof createClient>;

// TCP handshake + TLS negotiation can take a moment on a cold connection.
// Redis official docs recommend 1-3s for connect (redis.io/docs/latest/develop/clients).
const CONNECT_TIMEOUT_MS = 1_500;

// Simple GET/SET commands complete in sub-millisecond; anything over 200ms
// means Redis is overloaded or unreachable and we should fail open.
const COMMAND_TIMEOUT_MS = 200;

let client: RedisClient | null = null;
let connectPromise: Promise<unknown> | null = null;

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
  if (c.isOpen) return c;
  if (!connectPromise) {
    connectPromise = c.connect().catch(err => {
      captureException(err, { tags: { service: 'redis', operation: 'connect' } });
      connectPromise = null;
      throw err;
    });
  }
  await connectPromise;
  return c;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Redis timeout')), ms);
    }),
  ]);
}

export async function redisGet(key: RedisKey): Promise<string | null> {
  const c = getOrCreateClient();
  if (!c) return null;
  try {
    await withTimeout(ensureConnected(c), CONNECT_TIMEOUT_MS);
    return await withTimeout(c.get(key), COMMAND_TIMEOUT_MS);
  } catch (err) {
    captureException(err, { tags: { service: 'redis', operation: 'get' }, extra: { key } });
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
    await withTimeout(ensureConnected(c), CONNECT_TIMEOUT_MS);
    if (ttlSeconds) {
      await withTimeout(c.set(key, value, { EX: ttlSeconds }), COMMAND_TIMEOUT_MS);
    } else {
      await withTimeout(c.set(key, value), COMMAND_TIMEOUT_MS);
    }
    return true;
  } catch (err) {
    captureException(err, { tags: { service: 'redis', operation: 'set' }, extra: { key } });
    throw err;
  }
}
