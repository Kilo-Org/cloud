import { describe, expect, it, vi } from 'vitest';
import { AutoRoutingModeConfigDO } from './routing-mode';

function createModeDO(initial: Record<string, unknown>) {
  const entries = new Map(Object.entries(initial));
  const storage = {
    get: vi.fn(async (keys: string[]) => new Map(keys.map(key => [key, entries.get(key)]))),
    put: vi.fn(async (key: string, value: unknown) => {
      entries.set(key, value);
    }),
    delete: vi.fn(),
    transaction: vi.fn(),
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
});
