import { describe, expect, it, vi } from 'vitest';

// Mock cloudflare:workers
vi.mock('cloudflare:workers', () => ({
  DurableObject: class FakeDurableObject {
    ctx: { storage: unknown };
    env: unknown;
    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx as { storage: unknown };
      this.env = env;
    }
  },
}));

import { GmailPushIdempotency } from './idempotency';

function createFakeStorage() {
  const store = new Map<string, unknown>();
  return {
    get: vi.fn((key: string) => Promise.resolve(store.get(key))),
    put: vi.fn((key: string, value: unknown) => {
      store.set(key, value);
      return Promise.resolve();
    }),
    delete: vi.fn((keys: string[]) => {
      for (const k of keys) store.delete(k);
      return Promise.resolve();
    }),
    list: vi.fn((opts?: { prefix?: string; limit?: number; startAfter?: string }) => {
      const result = new Map<string, unknown>();
      const sorted = [...store.entries()]
        .filter(([k]) => !opts?.prefix || k.startsWith(opts.prefix))
        .sort(([a], [b]) => a.localeCompare(b));
      for (const [k, v] of sorted) {
        if (opts?.startAfter && k <= opts.startAfter) continue;
        result.set(k, v);
        if (opts?.limit && result.size >= opts.limit) break;
      }
      return Promise.resolve(result);
    }),
    setAlarm: vi.fn(),
    _store: store,
  };
}

function createInstance(storage = createFakeStorage()) {
  const ctx = { storage } as unknown;
  const instance = new GmailPushIdempotency(
    ctx as ConstructorParameters<typeof GmailPushIdempotency>[0],
    {} as ConstructorParameters<typeof GmailPushIdempotency>[1]
  );
  return { instance, storage };
}

describe('GmailPushIdempotency', () => {
  describe('checkAndMark', () => {
    it('returns false on first call (not a duplicate)', async () => {
      const { instance } = createInstance();
      const result = await instance.checkAndMark('msg-1');
      expect(result).toBe(false);
    });

    it('returns true on second call with same messageId (duplicate)', async () => {
      const { instance } = createInstance();
      await instance.checkAndMark('msg-2');
      const result = await instance.checkAndMark('msg-2');
      expect(result).toBe(true);
    });

    it('returns false for different messageIds', async () => {
      const { instance } = createInstance();
      await instance.checkAndMark('msg-3');
      const result = await instance.checkAndMark('msg-4');
      expect(result).toBe(false);
    });

    it('stores timestamp in storage', async () => {
      const { instance, storage } = createInstance();
      const before = Date.now();
      await instance.checkAndMark('msg-5');
      const stored = storage._store.get('msg:msg-5') as number;
      expect(stored).toBeGreaterThanOrEqual(before);
      expect(stored).toBeLessThanOrEqual(Date.now());
    });

    it('sets alarm on first mark', async () => {
      const { instance, storage } = createInstance();
      await instance.checkAndMark('msg-6');
      expect(storage.setAlarm).toHaveBeenCalled();
    });
  });

  describe('alarm', () => {
    it('deletes entries older than 24h', async () => {
      const storage = createFakeStorage();
      const { instance } = createInstance(storage);
      const old = Date.now() - 86_400_000 - 1000;
      storage._store.set('msg:old-1', old);
      storage._store.set('msg:old-2', old);
      storage._store.set('msg:recent', Date.now());

      await instance.alarm();

      expect(storage.delete).toHaveBeenCalledWith(['msg:old-1', 'msg:old-2']);
    });

    it('re-arms alarm if entries remain after cleanup', async () => {
      const storage = createFakeStorage();
      const { instance } = createInstance(storage);
      storage._store.set('msg:old', Date.now() - 86_400_000 - 1000);
      storage._store.set('msg:recent', Date.now());

      await instance.alarm();

      expect(storage.setAlarm).toHaveBeenCalled();
    });

    it('does not re-arm alarm if all entries deleted', async () => {
      const storage = createFakeStorage();
      const { instance } = createInstance(storage);
      storage._store.set('msg:old', Date.now() - 86_400_000 - 1000);

      await instance.alarm();

      expect(storage.setAlarm).not.toHaveBeenCalled();
    });
  });
});
