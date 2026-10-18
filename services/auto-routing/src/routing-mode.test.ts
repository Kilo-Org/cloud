import { describe, expect, it, vi } from 'vitest';
import { AutoRoutingModeConfigDO } from './routing-mode';

function createModeDO(initial: Record<string, unknown>) {
  const entries = new Map(Object.entries(initial));
  const storage = {
    entries,
    get: async (key: string | string[]) =>
      Array.isArray(key)
        ? new Map(key.filter(name => entries.has(name)).map(name => [name, entries.get(name)]))
        : entries.get(key),
    put: vi.fn(async (keyOrEntries: string | Record<string, unknown>, value?: unknown) => {
      if (typeof keyOrEntries === 'string') entries.set(keyOrEntries, value);
      else for (const [key, entry] of Object.entries(keyOrEntries)) entries.set(key, entry);
    }),
    delete: vi.fn(async (keyOrKeys: string | string[]) => {
      for (const key of typeof keyOrKeys === 'string' ? [keyOrKeys] : keyOrKeys)
        entries.delete(key);
    }),
    transaction: vi.fn(
      async <T>(
        callback: (txn: {
          put: (keyOrEntries: string | Record<string, unknown>, value?: unknown) => Promise<void>;
          delete: (keyOrKeys: string | string[]) => Promise<void>;
          get: (key: string | string[]) => Promise<unknown>;
        }) => Promise<T>
      ): Promise<T> => {
        const shadow = new Map(entries);
        const txn = {
          get: async (key: string | string[]) =>
            Array.isArray(key)
              ? new Map(key.filter(name => shadow.has(name)).map(name => [name, shadow.get(name)]))
              : shadow.get(key),
          put: async (keyOrEntries: string | Record<string, unknown>, value?: unknown) => {
            if (typeof keyOrEntries === 'string') shadow.set(keyOrEntries, value);
            else for (const [key, entry] of Object.entries(keyOrEntries)) shadow.set(key, entry);
          },
          delete: async (keyOrKeys: string | string[]) => {
            for (const key of typeof keyOrKeys === 'string' ? [keyOrKeys] : keyOrKeys)
              shadow.delete(key);
          },
        };
        const result = await callback(txn);
        entries.clear();
        for (const [key, value] of shadow) {
          entries.set(key, value);
        }
        return result;
      }
    ),
  };
  const modeDO = new AutoRoutingModeConfigDO(
    { storage } as unknown as DurableObjectState,
    {} as Env
  );
  return { modeDO, storage, entries };
}

const NOTHING_STORED = {
  mode: null,
  pool: null,
  invalidMode: false,
  invalidPool: false,
  convertedAt: null,
  failedAt: null,
};

describe('AutoRoutingModeConfigDO', () => {
  it('returns nulls when nothing is stored', async () => {
    const { modeDO } = createModeDO({});
    await expect(modeDO.readStoredSettings()).resolves.toEqual(NOTHING_STORED);
  });

  it('returns the stored mode and pool in pool order', async () => {
    const pool = [{ model: 'b/chat' }, { model: 'a/chat' }];
    const { modeDO } = createModeDO({ mode: 'best_accuracy', pool });
    await expect(modeDO.readStoredSettings()).resolves.toEqual({
      ...NOTHING_STORED,
      mode: 'best_accuracy',
      pool,
    });
  });

  it('flags an invalid stored mode and pool instead of treating them as absent', async () => {
    const { modeDO } = createModeDO({ mode: 'fastest', pool: [{ model: '' }] });
    await expect(modeDO.readStoredSettings()).resolves.toEqual({
      ...NOTHING_STORED,
      invalidMode: true,
      invalidPool: true,
    });
  });

  it('normalizes duplicate pool entries without writing back', async () => {
    const { modeDO, storage, entries } = createModeDO({
      pool: [{ model: 'a/chat' }, { model: 'a/chat' }, { model: 'b/chat' }],
    });

    await expect(modeDO.readStoredSettings()).resolves.toEqual({
      ...NOTHING_STORED,
      pool: [{ model: 'a/chat' }, { model: 'b/chat' }],
    });
    expect(entries.get('pool')).toHaveLength(3);
    expect(storage.put).not.toHaveBeenCalled();
    expect(storage.delete).not.toHaveBeenCalled();
    expect(storage.transaction).not.toHaveBeenCalled();
  });

  it('records the conversion and reports it on later reads, keeping the stored pool', async () => {
    const pool = [{ model: 'a/chat' }];
    const { modeDO } = createModeDO({ pool });

    await modeDO.markConverted('2026-10-17T00:00:00.000Z');

    await expect(modeDO.readStoredSettings()).resolves.toEqual({
      ...NOTHING_STORED,
      pool,
      convertedAt: '2026-10-17T00:00:00.000Z',
    });
  });

  it('retains a pending snapshot for retry without changing legacy data', async () => {
    const pool = [{ model: 'a/chat' }];
    const { modeDO, entries } = createModeDO({ mode: 'best_accuracy', pool });
    await expect(modeDO.beginConversion()).resolves.toMatchObject({ mode: 'best_accuracy', pool });
    entries.set('pool', [{ model: 'later/chat' }]);
    await modeDO.markFailed('2026-10-18T00:00:00.000Z');
    expect((await modeDO.beginConversion()).pool).toEqual(pool);
    await modeDO.markConverted('2026-10-18T01:00:00.000Z', true);
    expect(entries.get('pool')).toEqual([{ model: 'later/chat' }]);
    expect(entries.has('conversionPending')).toBe(false);
    expect(entries.get('poolMigratedAt')).toBe('2026-10-18T01:00:00.000Z');
  });

  it('does not snapshot mode-only owners or invalid pools', async () => {
    const { modeDO, entries } = createModeDO({ mode: 'best_accuracy' });
    await modeDO.beginConversion();
    expect(entries.has('conversionPending')).toBe(false);
    entries.set('pool', [{ model: 'client:fixture/model' }]);
    await modeDO.beginConversion();
    expect(entries.has('conversionPending')).toBe(false);
  });

  it('records a failed conversion attempt separately from the conversion', async () => {
    const pool = [{ model: 'a/chat' }];
    const { modeDO } = createModeDO({ pool });

    await modeDO.markFailed('2026-10-17T00:00:00.000Z');

    await expect(modeDO.readStoredSettings()).resolves.toEqual({
      ...NOTHING_STORED,
      pool,
      failedAt: '2026-10-17T00:00:00.000Z',
    });
  });
});
