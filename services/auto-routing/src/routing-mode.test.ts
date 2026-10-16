import { describe, expect, it, vi } from 'vitest';
import { AutoRoutingModeConfigDO } from './routing-mode';

function createModeDO(initial: Record<string, unknown>) {
  const entries = new Map(Object.entries(initial));
  const storage = {
    get: vi.fn(async (keys: string[]) => new Map(keys.map(key => [key, entries.get(key)]))),
    put: vi.fn(),
    delete: vi.fn(),
    transaction: vi.fn(),
  };
  const modeDO = new AutoRoutingModeConfigDO(
    { storage } as unknown as DurableObjectState,
    {} as Env
  );
  return { modeDO, storage, entries };
}

describe('AutoRoutingModeConfigDO.readStoredSettings', () => {
  it('returns nulls when nothing is stored', async () => {
    const { modeDO } = createModeDO({});
    await expect(modeDO.readStoredSettings()).resolves.toEqual({ mode: null, pool: null });
  });

  it('returns the stored mode and pool in pool order', async () => {
    const pool = [{ model: 'b/chat' }, { model: 'a/chat' }];
    const { modeDO } = createModeDO({ mode: 'best_accuracy', pool });
    await expect(modeDO.readStoredSettings()).resolves.toEqual({ mode: 'best_accuracy', pool });
  });

  it('treats invalid stored values as absent', async () => {
    const { modeDO } = createModeDO({ mode: 'fastest', pool: [{ model: '' }] });
    await expect(modeDO.readStoredSettings()).resolves.toEqual({ mode: null, pool: null });
  });

  it('normalizes duplicate pool entries without writing back', async () => {
    const { modeDO, storage, entries } = createModeDO({
      pool: [{ model: 'a/chat' }, { model: 'a/chat' }, { model: 'b/chat' }],
    });

    await expect(modeDO.readStoredSettings()).resolves.toEqual({
      mode: null,
      pool: [{ model: 'a/chat' }, { model: 'b/chat' }],
    });
    expect(entries.get('pool')).toHaveLength(3);
    expect(storage.put).not.toHaveBeenCalled();
    expect(storage.delete).not.toHaveBeenCalled();
    expect(storage.transaction).not.toHaveBeenCalled();
  });
});
