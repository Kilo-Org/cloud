import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AutoRoutingModeConfigDO,
  getConfiguredAutoRoutingMode,
  getConfiguredAutoRoutingSettings,
  getAutoRoutingMode,
  getEffectiveAutoRoutingSettings,
  setAutoRoutingMode,
  setAutoRoutingSettings,
} from './routing-mode';
import type { AutoRoutingMode, EfficientModelPool } from '@kilocode/auto-routing-contracts';
import type { AutoRoutingOwnerSettings } from './routing-mode';

type ModeStub = {
  getMode: ReturnType<typeof vi.fn<() => Promise<AutoRoutingMode | null>>>;
  setMode: ReturnType<typeof vi.fn<(mode: AutoRoutingMode | null) => Promise<void>>>;
  getPool: ReturnType<typeof vi.fn<() => Promise<EfficientModelPool | null>>>;
  setPool: ReturnType<typeof vi.fn<(pool: EfficientModelPool | null) => Promise<void>>>;
  getSettings: ReturnType<typeof vi.fn<() => Promise<AutoRoutingOwnerSettings>>>;
  setSettings: ReturnType<typeof vi.fn<(settings: AutoRoutingOwnerSettings) => Promise<void>>>;
};

const SAMPLE_POOL: EfficientModelPool = [
  { model: 'a/chat', variant: 'thinking' },
  { model: 'b/chat', variant: null },
];

function makeEnv(
  initial: Record<string, { mode?: AutoRoutingMode | null; pool?: EfficientModelPool | null }> = {}
) {
  const modes = new Map<string, AutoRoutingMode | null>();
  const pools = new Map<string, EfficientModelPool | null>();
  for (const [key, value] of Object.entries(initial)) {
    modes.set(key, value.mode ?? null);
    pools.set(key, value.pool ?? null);
  }
  const stubs = new Map<string, ModeStub>();
  const idFromName = vi.fn((name: string) => name);
  const get = vi.fn((id: string) => {
    const existing = stubs.get(id);
    if (existing) return existing;
    const stub: ModeStub = {
      getMode: vi.fn(async () => modes.get(id) ?? null),
      setMode: vi.fn(async (mode: AutoRoutingMode | null) => {
        modes.set(id, mode);
      }),
      getPool: vi.fn(async () => pools.get(id) ?? null),
      setPool: vi.fn(async (pool: EfficientModelPool | null) => {
        pools.set(id, pool);
      }),
      getSettings: vi.fn(async () => ({
        mode: modes.get(id) ?? null,
        pool: pools.get(id) ?? null,
      })),
      setSettings: vi.fn(async (settings: AutoRoutingOwnerSettings) => {
        modes.set(id, settings.mode);
        pools.set(id, settings.pool);
      }),
    };
    stubs.set(id, stub);
    return stub;
  });
  const env = {
    AUTO_ROUTING_MODE_CONFIG: {
      idFromName,
      get,
    },
  } as unknown as Pick<Env, 'AUTO_ROUTING_MODE_CONFIG'>;

  return { env, modes, pools, stubs, idFromName, get };
}

function createFakeStorage() {
  const entries = new Map<string, unknown>();

  return {
    entries,
    get: async (key: string) => entries.get(key),
    put: async (keyOrEntries: string | Record<string, unknown>, value?: unknown) => {
      if (typeof keyOrEntries === 'string') {
        entries.set(keyOrEntries, value);
        return;
      }
      for (const [key, entryValue] of Object.entries(keyOrEntries)) {
        entries.set(key, entryValue);
      }
    },
    delete: async (keyOrKeys: string | string[]) => {
      if (typeof keyOrKeys === 'string') {
        entries.delete(keyOrKeys);
        return;
      }
      for (const key of keyOrKeys) {
        entries.delete(key);
      }
    },
  };
}

function createModeDO() {
  const storage = createFakeStorage();
  const modeDO = new AutoRoutingModeConfigDO(
    { storage } as unknown as DurableObjectState,
    {} as Env
  );
  return { modeDO, storage };
}

describe('AutoRoutingModeConfigDO', () => {
  it('persists, clears, and validates the stored mode', async () => {
    const { modeDO, storage } = createModeDO();

    await expect(modeDO.getMode()).resolves.toBeNull();
    await modeDO.setMode('best_accuracy');
    await expect(modeDO.getMode()).resolves.toBe('best_accuracy');

    storage.entries.set('mode', 'fastest');
    await expect(modeDO.getMode()).resolves.toBeNull();

    await modeDO.setMode(null);
    expect(storage.entries.has('mode')).toBe(false);
  });

  it('round-trips pool get/set/clear and rejects malformed stored pools', async () => {
    const { modeDO, storage } = createModeDO();

    await expect(modeDO.getPool()).resolves.toBeNull();
    await modeDO.setPool(SAMPLE_POOL);
    await expect(modeDO.getPool()).resolves.toEqual(SAMPLE_POOL);

    storage.entries.set('pool', [{ model: '', variant: null }]);
    await expect(modeDO.getPool()).resolves.toBeNull();

    await modeDO.setPool(null);
    expect(storage.entries.has('pool')).toBe(false);
  });

  it('reads and writes combined settings in one RPC shape', async () => {
    const { modeDO } = createModeDO();

    await expect(modeDO.getSettings()).resolves.toEqual({ mode: null, pool: null });
    await modeDO.setSettings({ mode: 'best_accuracy', pool: SAMPLE_POOL });
    await expect(modeDO.getSettings()).resolves.toEqual({
      mode: 'best_accuracy',
      pool: SAMPLE_POOL,
    });
    await modeDO.setSettings({ mode: null, pool: null });
    await expect(modeDO.getSettings()).resolves.toEqual({ mode: null, pool: null });
  });

  it('commits mode and pool via one multi-key put and paired multi-key delete', async () => {
    const { modeDO, storage } = createModeDO();
    const putSpy = vi.spyOn(storage, 'put');
    const deleteSpy = vi.spyOn(storage, 'delete');

    await modeDO.setSettings({ mode: 'best_accuracy', pool: SAMPLE_POOL });
    expect(putSpy).toHaveBeenCalledTimes(1);
    expect(putSpy).toHaveBeenCalledWith({ mode: 'best_accuracy', pool: SAMPLE_POOL });
    expect(deleteSpy).not.toHaveBeenCalled();

    putSpy.mockClear();
    deleteSpy.mockClear();
    await modeDO.setSettings({ mode: null, pool: null });
    expect(deleteSpy).toHaveBeenCalledTimes(1);
    expect(deleteSpy).toHaveBeenCalledWith(['mode', 'pool']);
    expect(putSpy).not.toHaveBeenCalled();

    putSpy.mockClear();
    deleteSpy.mockClear();
    await modeDO.setSettings({ mode: 'cost_per_accuracy', pool: null });
    expect(putSpy).toHaveBeenCalledWith({ mode: 'cost_per_accuracy' });
    expect(deleteSpy).toHaveBeenCalledWith(['pool']);
  });
});

describe('auto routing mode config', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('defaults to best accuracy per dollar when no owner config exists', async () => {
    const { env } = makeEnv();

    await expect(getAutoRoutingMode(env, { userId: 'user-1', organizationId: null })).resolves.toBe(
      'cost_per_accuracy'
    );
  });

  it('uses organization mode before user mode', async () => {
    const { env, idFromName } = makeEnv({
      'user:user-1': { mode: 'best_accuracy' },
      'org:org-1': { mode: 'cost_per_accuracy' },
    });

    await expect(
      getAutoRoutingMode(env, { userId: 'user-1', organizationId: 'org-1' })
    ).resolves.toBe('cost_per_accuracy');
    expect(idFromName).toHaveBeenCalledWith('org:org-1');
  });

  it('falls back to user mode when organization mode is absent', async () => {
    const { env } = makeEnv({
      'user:user-1': { mode: 'best_accuracy' },
    });

    await expect(
      getAutoRoutingMode(env, { userId: 'user-1', organizationId: 'org-1' })
    ).resolves.toBe('best_accuracy');
  });

  it('reads the owner object on every lookup instead of serving a stale module value', async () => {
    const { env, modes, stubs } = makeEnv({
      'user:user-1': { mode: 'best_accuracy' },
    });

    await expect(
      getConfiguredAutoRoutingMode(env, { ownerType: 'user', ownerId: 'user-1' })
    ).resolves.toBe('best_accuracy');

    modes.set('user:user-1', 'cost_per_accuracy');

    await expect(
      getConfiguredAutoRoutingMode(env, { ownerType: 'user', ownerId: 'user-1' })
    ).resolves.toBe('cost_per_accuracy');
    expect(stubs.get('user:user-1')?.getMode).toHaveBeenCalledTimes(2);
  });

  it('writes and clears owner-specific modes in the owner object', async () => {
    const { env, modes, stubs } = makeEnv();

    await setAutoRoutingMode(env, { ownerType: 'org', ownerId: 'org-1' }, 'best_accuracy');
    expect(modes.get('org:org-1')).toBe('best_accuracy');
    expect(stubs.get('org:org-1')?.setMode).toHaveBeenCalledWith('best_accuracy');

    await setAutoRoutingMode(env, { ownerType: 'org', ownerId: 'org-1' }, null);
    expect(modes.get('org:org-1')).toBeNull();
    expect(stubs.get('org:org-1')?.setMode).toHaveBeenLastCalledWith(null);
  });

  it('returns null when reading an owner object fails', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { env, stubs } = makeEnv();
    await getConfiguredAutoRoutingMode(env, { ownerType: 'user', ownerId: 'user-1' });
    stubs.get('user:user-1')?.getMode.mockRejectedValueOnce(new Error('do unavailable'));

    await expect(
      getConfiguredAutoRoutingMode(env, { ownerType: 'user', ownerId: 'user-1' })
    ).resolves.toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('auto_routing_config_read_failed')
    );
  });

  it('resolves mode and pool independently (org pool + personal mode)', async () => {
    const { env } = makeEnv({
      'user:user-1': { mode: 'best_accuracy', pool: null },
      'org:org-1': { mode: null, pool: SAMPLE_POOL },
    });

    await expect(
      getEffectiveAutoRoutingSettings(env, { userId: 'user-1', organizationId: 'org-1' })
    ).resolves.toEqual({
      mode: 'best_accuracy',
      pool: SAMPLE_POOL,
    });
  });

  it('resolves mode and pool independently (org mode + personal pool)', async () => {
    const personalPool: EfficientModelPool = [{ model: 'personal/chat', variant: 'max' }];
    const { env } = makeEnv({
      'user:user-1': { mode: null, pool: personalPool },
      'org:org-1': { mode: 'best_accuracy', pool: null },
    });

    await expect(
      getEffectiveAutoRoutingSettings(env, { userId: 'user-1', organizationId: 'org-1' })
    ).resolves.toEqual({
      mode: 'best_accuracy',
      pool: personalPool,
    });
  });

  it('lets org pool override personal pool and clearing restore inheritance', async () => {
    const personalPool: EfficientModelPool = [{ model: 'personal/chat', variant: null }];
    const orgPool: EfficientModelPool = [{ model: 'org/chat', variant: 'thinking' }];
    const { env, modes, pools } = makeEnv({
      'user:user-1': { mode: 'cost_per_accuracy', pool: personalPool },
      'org:org-1': { mode: null, pool: orgPool },
    });

    await expect(
      getEffectiveAutoRoutingSettings(env, { userId: 'user-1', organizationId: 'org-1' })
    ).resolves.toEqual({ mode: 'cost_per_accuracy', pool: orgPool });

    pools.set('org:org-1', null);
    modes.set('org:org-1', null);

    await expect(
      getEffectiveAutoRoutingSettings(env, { userId: 'user-1', organizationId: 'org-1' })
    ).resolves.toEqual({ mode: 'cost_per_accuracy', pool: personalPool });
  });

  it('writes combined settings through the owner stub', async () => {
    const { env, modes, pools, stubs } = makeEnv();

    await setAutoRoutingSettings(
      env,
      { ownerType: 'user', ownerId: 'user-1' },
      { mode: 'best_accuracy', pool: SAMPLE_POOL }
    );
    expect(modes.get('user:user-1')).toBe('best_accuracy');
    expect(pools.get('user:user-1')).toEqual(SAMPLE_POOL);
    expect(stubs.get('user:user-1')?.setSettings).toHaveBeenCalledWith({
      mode: 'best_accuracy',
      pool: SAMPLE_POOL,
    });

    await expect(
      getConfiguredAutoRoutingSettings(env, { ownerType: 'user', ownerId: 'user-1' })
    ).resolves.toEqual({ mode: 'best_accuracy', pool: SAMPLE_POOL });
  });

  it('degrades pool to null when configured settings read fails', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { env, stubs } = makeEnv({
      'user:user-1': { mode: 'best_accuracy', pool: SAMPLE_POOL },
    });
    await getConfiguredAutoRoutingSettings(env, { ownerType: 'user', ownerId: 'user-1' });
    stubs.get('user:user-1')?.getSettings.mockRejectedValueOnce(new Error('do unavailable'));

    await expect(
      getConfiguredAutoRoutingSettings(env, { ownerType: 'user', ownerId: 'user-1' })
    ).resolves.toEqual({ mode: null, pool: null });
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('auto_routing_config_read_failed')
    );
  });
});
