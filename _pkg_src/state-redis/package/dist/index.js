// src/index.ts
import { ConsoleLogger } from "chat";
import { createClient } from "redis";
var RedisStateAdapter = class {
  client;
  keyPrefix;
  logger;
  connected = false;
  connectPromise = null;
  constructor(options) {
    this.client = createClient({ url: options.url });
    this.keyPrefix = options.keyPrefix || "chat-sdk";
    this.logger = options.logger;
    this.client.on("error", (err) => {
      this.logger.error("Redis client error", { error: err });
    });
  }
  key(type, id) {
    return `${this.keyPrefix}:${type}:${id}`;
  }
  subscriptionsSetKey() {
    return `${this.keyPrefix}:subscriptions`;
  }
  async connect() {
    if (this.connected) {
      return;
    }
    if (!this.connectPromise) {
      this.connectPromise = this.client.connect().then(() => {
        this.connected = true;
      });
    }
    await this.connectPromise;
  }
  async disconnect() {
    if (this.connected) {
      await this.client.close();
      this.connected = false;
      this.connectPromise = null;
    }
  }
  async subscribe(threadId) {
    this.ensureConnected();
    await this.client.sAdd(this.subscriptionsSetKey(), threadId);
  }
  async unsubscribe(threadId) {
    this.ensureConnected();
    await this.client.sRem(this.subscriptionsSetKey(), threadId);
  }
  async isSubscribed(threadId) {
    this.ensureConnected();
    const result = await this.client.sIsMember(
      this.subscriptionsSetKey(),
      threadId
    );
    return result === 1;
  }
  async acquireLock(threadId, ttlMs) {
    this.ensureConnected();
    const token = generateToken();
    const lockKey = this.key("lock", threadId);
    const acquired = await this.client.set(lockKey, token, {
      NX: true,
      PX: ttlMs
    });
    if (acquired) {
      return {
        threadId,
        token,
        expiresAt: Date.now() + ttlMs
      };
    }
    return null;
  }
  async forceReleaseLock(threadId) {
    this.ensureConnected();
    const lockKey = this.key("lock", threadId);
    await this.client.del(lockKey);
  }
  async releaseLock(lock) {
    this.ensureConnected();
    const lockKey = this.key("lock", lock.threadId);
    const script = `
      if redis.call("get", KEYS[1]) == ARGV[1] then
        return redis.call("del", KEYS[1])
      else
        return 0
      end
    `;
    await this.client.eval(script, {
      keys: [lockKey],
      arguments: [lock.token]
    });
  }
  async extendLock(lock, ttlMs) {
    this.ensureConnected();
    const lockKey = this.key("lock", lock.threadId);
    const script = `
      if redis.call("get", KEYS[1]) == ARGV[1] then
        return redis.call("pexpire", KEYS[1], ARGV[2])
      else
        return 0
      end
    `;
    const result = await this.client.eval(script, {
      keys: [lockKey],
      arguments: [lock.token, ttlMs.toString()]
    });
    return result === 1;
  }
  async get(key) {
    this.ensureConnected();
    const cacheKey = this.key("cache", key);
    const value = await this.client.get(cacheKey);
    if (value === null) {
      return null;
    }
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }
  async set(key, value, ttlMs) {
    this.ensureConnected();
    const cacheKey = this.key("cache", key);
    const serialized = JSON.stringify(value);
    if (ttlMs) {
      await this.client.set(cacheKey, serialized, { PX: ttlMs });
    } else {
      await this.client.set(cacheKey, serialized);
    }
  }
  async setIfNotExists(key, value, ttlMs) {
    this.ensureConnected();
    const cacheKey = this.key("cache", key);
    const serialized = JSON.stringify(value);
    const result = ttlMs ? await this.client.set(cacheKey, serialized, { NX: true, PX: ttlMs }) : await this.client.set(cacheKey, serialized, { NX: true });
    return result !== null;
  }
  async delete(key) {
    this.ensureConnected();
    const cacheKey = this.key("cache", key);
    await this.client.del(cacheKey);
  }
  async appendToList(key, value, options) {
    this.ensureConnected();
    const listKey = `${this.keyPrefix}:list:${key}`;
    const serialized = JSON.stringify(value);
    const maxLength = options?.maxLength ?? 0;
    const ttlMs = options?.ttlMs ?? 0;
    const script = `
      redis.call("rpush", KEYS[1], ARGV[1])
      if tonumber(ARGV[2]) > 0 then
        redis.call("ltrim", KEYS[1], -tonumber(ARGV[2]), -1)
      end
      if tonumber(ARGV[3]) > 0 then
        redis.call("pexpire", KEYS[1], tonumber(ARGV[3]))
      end
      return 1
    `;
    await this.client.eval(script, {
      keys: [listKey],
      arguments: [serialized, maxLength.toString(), ttlMs.toString()]
    });
  }
  async getList(key) {
    this.ensureConnected();
    const listKey = `${this.keyPrefix}:list:${key}`;
    const values = await this.client.lRange(listKey, 0, -1);
    return values.map((v) => JSON.parse(v));
  }
  ensureConnected() {
    if (!this.connected) {
      throw new Error(
        "RedisStateAdapter is not connected. Call connect() first."
      );
    }
  }
  /**
   * Get the underlying Redis client for advanced usage.
   */
  getClient() {
    return this.client;
  }
};
function generateToken() {
  return `redis_${Date.now()}_${Math.random().toString(36).substring(2, 15)}`;
}
function createRedisState(options) {
  const url = options?.url ?? process.env.REDIS_URL;
  if (!url) {
    throw new Error(
      "Redis url is required. Set REDIS_URL or provide it in options."
    );
  }
  const resolved = {
    url,
    keyPrefix: options?.keyPrefix,
    logger: options?.logger ?? new ConsoleLogger("info").child("redis")
  };
  return new RedisStateAdapter(resolved);
}
export {
  RedisStateAdapter,
  createRedisState
};
//# sourceMappingURL=index.js.map