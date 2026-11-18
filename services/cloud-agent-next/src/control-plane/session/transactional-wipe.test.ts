import { describe, expect, it } from 'vitest';
import { runTransactionalWipe, type WipeTransactionStorage } from './transactional-wipe.js';

function fakeStorage(initial: Record<string, unknown> = {}): {
  storage: WipeTransactionStorage;
  snapshot: () => Record<string, unknown>;
} {
  let data = new Map(Object.entries(initial));
  const kv = {
    put(key: string, value: unknown) {
      data.set(key, value);
    },
    delete(key: string) {
      return data.delete(key);
    },
    list() {
      return new Map(data);
    },
  };
  return {
    storage: {
      transactionSync<T>(callback: () => T): T {
        const before = new Map(data);
        try {
          return callback();
        } catch (error) {
          data = before;
          throw error;
        }
      },
      get kv() {
        return kv;
      },
    },
    snapshot: () => Object.fromEntries(data),
  };
}

describe('runTransactionalWipe', () => {
  it('keeps the locator and generation and removes every other KV key', () => {
    const { storage, snapshot } = fakeStorage({
      control_plane_generation: 2,
      control_plane_session: { sessionId: 's' },
      other: 'value',
    });
    let deletedTables = 0;
    runTransactionalWipe({
      storage,
      locatorKey: 'locator',
      generationKey: 'control_plane_generation',
      generation: 2,
      locator: { sandboxId: 'sb', expiresAt: 1 },
      deleteApplicationTables: () => {
        deletedTables += 1;
      },
    });
    expect(deletedTables).toBe(1);
    expect(snapshot()).toEqual({
      control_plane_generation: 2,
      locator: { sandboxId: 'sb', expiresAt: 1 },
    });
  });

  it('rolls back every write when the transaction body throws', () => {
    const before = {
      control_plane_generation: 2,
      control_plane_session: { sessionId: 's' },
      other: 'value',
    };
    const { storage, snapshot } = fakeStorage(before);
    let deletedTables = 0;
    expect(() =>
      runTransactionalWipe({
        storage,
        locatorKey: 'locator',
        generationKey: 'control_plane_generation',
        generation: 2,
        locator: { sandboxId: 'sb', expiresAt: 1 },
        deleteApplicationTables: () => {
          deletedTables += 1;
          throw new Error('wipe failure');
        },
      })
    ).toThrow('wipe failure');
    expect(deletedTables).toBe(1);
    expect(snapshot()).toEqual(before);
  });
});
