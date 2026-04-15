import { createClient } from 'redis';

type RedisClient = ReturnType<typeof createClient>;

let client: RedisClient | null = null;
let connectPromise: Promise<unknown> | null = null;

function getOrCreateClient(): RedisClient | null {
  if (!process.env.REDIS_URL) {
    return null;
  }
  if (!client) {
    client = createClient({ url: process.env.REDIS_URL });
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

export async function redisGet(key: string): Promise<string | null> {
  const c = getOrCreateClient();
  if (!c) return null;
  await ensureConnected(c);
  return c.get(key);
}

export async function redisSet(key: string, value: string, ttlSeconds?: number): Promise<void> {
  const c = getOrCreateClient();
  if (!c) return;
  await ensureConnected(c);
  if (ttlSeconds) {
    await c.set(key, value, { EX: ttlSeconds });
  } else {
    await c.set(key, value);
  }
}
