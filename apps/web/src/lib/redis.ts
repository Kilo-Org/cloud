import { createClient } from 'redis';

type RedisClient = ReturnType<typeof createClient>;

const COMMAND_TIMEOUT_MS = 2_000;

let client: RedisClient | null = null;
let connectPromise: Promise<unknown> | null = null;

function getOrCreateClient(): RedisClient | null {
  if (!process.env.REDIS_URL) {
    return null;
  }
  if (!client) {
    client = createClient({
      url: process.env.REDIS_URL,
      socket: { connectTimeout: COMMAND_TIMEOUT_MS },
    });
    client.on('error', err => {
      console.error('[redis] client error', err);
    });
  }
  return client;
}

async function ensureConnected(c: RedisClient): Promise<RedisClient> {
  if (c.isOpen) return c;
  if (!connectPromise) {
    connectPromise = c.connect().catch(err => {
      console.error('[redis] connect error', err);
      connectPromise = null;
      throw err;
    });
  }
  await connectPromise;
  return c;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Redis timeout')), ms)),
  ]);
}

export async function redisGet(key: string): Promise<string | null> {
  const c = getOrCreateClient();
  if (!c) return null;
  await withTimeout(ensureConnected(c), COMMAND_TIMEOUT_MS);
  return withTimeout(c.get(key), COMMAND_TIMEOUT_MS);
}

export async function redisSet(key: string, value: string, ttlSeconds?: number): Promise<void> {
  const c = getOrCreateClient();
  if (!c) return;
  await withTimeout(ensureConnected(c), COMMAND_TIMEOUT_MS);
  if (ttlSeconds) {
    await withTimeout(c.set(key, value, { EX: ttlSeconds }), COMMAND_TIMEOUT_MS);
  } else {
    await withTimeout(c.set(key, value), COMMAND_TIMEOUT_MS);
  }
}
