// src/index.ts
var MemoryStateAdapter = class {
  subscriptions = /* @__PURE__ */ new Set();
  locks = /* @__PURE__ */ new Map();
  cache = /* @__PURE__ */ new Map();
  connected = false;
  connectPromise = null;
  async connect() {
    if (this.connected) {
      return;
    }
    if (!this.connectPromise) {
      this.connectPromise = Promise.resolve().then(() => {
        if (process.env.NODE_ENV === "production") {
          console.warn(
            "[chat] MemoryStateAdapter is not recommended for production. Consider using @chat-adapter/state-redis instead."
          );
        }
        this.connected = true;
      });
    }
    await this.connectPromise;
  }
  async disconnect() {
    this.connected = false;
    this.connectPromise = null;
    this.subscriptions.clear();
    this.locks.clear();
  }
  async subscribe(threadId) {
    this.ensureConnected();
    this.subscriptions.add(threadId);
  }
  async unsubscribe(threadId) {
    this.ensureConnected();
    this.subscriptions.delete(threadId);
  }
  async isSubscribed(threadId) {
    this.ensureConnected();
    return this.subscriptions.has(threadId);
  }
  async acquireLock(threadId, ttlMs) {
    this.ensureConnected();
    this.cleanExpiredLocks();
    const existingLock = this.locks.get(threadId);
    if (existingLock && existingLock.expiresAt > Date.now()) {
      return null;
    }
    const lock = {
      threadId,
      token: generateToken(),
      expiresAt: Date.now() + ttlMs
    };
    this.locks.set(threadId, lock);
    return lock;
  }
  async forceReleaseLock(threadId) {
    this.ensureConnected();
    this.locks.delete(threadId);
  }
  async releaseLock(lock) {
    this.ensureConnected();
    const existingLock = this.locks.get(lock.threadId);
    if (existingLock && existingLock.token === lock.token) {
      this.locks.delete(lock.threadId);
    }
  }
  async extendLock(lock, ttlMs) {
    this.ensureConnected();
    const existingLock = this.locks.get(lock.threadId);
    if (!existingLock || existingLock.token !== lock.token) {
      return false;
    }
    if (existingLock.expiresAt < Date.now()) {
      this.locks.delete(lock.threadId);
      return false;
    }
    existingLock.expiresAt = Date.now() + ttlMs;
    return true;
  }
  async get(key) {
    this.ensureConnected();
    const cached = this.cache.get(key);
    if (!cached) {
      return null;
    }
    if (cached.expiresAt !== null && cached.expiresAt <= Date.now()) {
      this.cache.delete(key);
      return null;
    }
    return cached.value;
  }
  async set(key, value, ttlMs) {
    this.ensureConnected();
    this.cache.set(key, {
      value,
      expiresAt: ttlMs ? Date.now() + ttlMs : null
    });
  }
  async setIfNotExists(key, value, ttlMs) {
    this.ensureConnected();
    const existing = this.cache.get(key);
    if (existing) {
      if (existing.expiresAt !== null && existing.expiresAt <= Date.now()) {
        this.cache.delete(key);
      } else {
        return false;
      }
    }
    this.cache.set(key, {
      value,
      expiresAt: ttlMs ? Date.now() + ttlMs : null
    });
    return true;
  }
  async delete(key) {
    this.ensureConnected();
    this.cache.delete(key);
  }
  async appendToList(key, value, options) {
    this.ensureConnected();
    const cached = this.cache.get(key);
    let list;
    if (cached && cached.expiresAt !== null && cached.expiresAt <= Date.now()) {
      list = [];
    } else if (cached && Array.isArray(cached.value)) {
      list = cached.value;
    } else {
      list = [];
    }
    list.push(value);
    if (options?.maxLength && list.length > options.maxLength) {
      list = list.slice(list.length - options.maxLength);
    }
    this.cache.set(key, {
      value: list,
      expiresAt: options?.ttlMs ? Date.now() + options.ttlMs : null
    });
  }
  async getList(key) {
    this.ensureConnected();
    const cached = this.cache.get(key);
    if (!cached) {
      return [];
    }
    if (cached.expiresAt !== null && cached.expiresAt <= Date.now()) {
      this.cache.delete(key);
      return [];
    }
    if (Array.isArray(cached.value)) {
      return cached.value;
    }
    return [];
  }
  ensureConnected() {
    if (!this.connected) {
      throw new Error(
        "MemoryStateAdapter is not connected. Call connect() first."
      );
    }
  }
  cleanExpiredLocks() {
    const now = Date.now();
    for (const [threadId, lock] of this.locks) {
      if (lock.expiresAt <= now) {
        this.locks.delete(threadId);
      }
    }
  }
  // For testing purposes
  _getSubscriptionCount() {
    return this.subscriptions.size;
  }
  _getLockCount() {
    this.cleanExpiredLocks();
    return this.locks.size;
  }
};
function generateToken() {
  return `mem_${Date.now()}_${Math.random().toString(36).substring(2, 15)}`;
}
function createMemoryState() {
  return new MemoryStateAdapter();
}
export {
  MemoryStateAdapter,
  createMemoryState
};
//# sourceMappingURL=index.js.map