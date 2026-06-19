import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AutoRoutingModeConfigDO,
  getConfiguredAutoRoutingMode,
  getAutoRoutingMode,
  setAutoRoutingMode,
} from './routing-mode';
import type { AutoRoutingMode } from '@kilocode/auto-routing-contracts';

type ModeStub = {
  getMode: ReturnType<typeof vi.fn<() => Promise<AutoRoutingMode | null>>>;
  setMode: ReturnType<typeof vi.fn<(mode: AutoRoutingMode | null) => Promise<void>>>;
};

function makeEnv(initialModes: Record<string, AutoRoutingMode | null> = {}) {
  const modes = new Map<string, AutoRoutingMode | null>(Object.entries(initialModes));
  const stubs = new Map<string, ModeStub>();
  const idFromName = vi.fn((name: string) => name);
  const get = vi.fn((id: string) => {
    const existing = stubs.get(id);
    if (existing) return existing;
    const stub = {
      getMode: vi.fn(async () => modes.get(id) ?? null),
      setMode: vi.fn(async (mode: AutoRoutingMode | null) => {
        modes.set(id, mode);
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

  return { env, modes, stubs, idFromName, get };
}

function createFakeStorage() {
  const entries = new Map<string, unknown>();

  return {
    entries,
    get: async (key: string) => entries.get(key),
    put: async (key: string, value: unknown) => {
      entries.set(key, value);
    },
    delete: async (key: string) => {
      entries.delete(key);
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
      'user:user-1': 'best_accuracy',
      'org:org-1': 'cost_per_accuracy',
    });

    await expect(
      getAutoRoutingMode(env, { userId: 'user-1', organizationId: 'org-1' })
    ).resolves.toBe('cost_per_accuracy');
    expect(idFromName).toHaveBeenNthCalledWith(1, 'org:org-1');
  });

  it('falls back to user mode when organization mode is absent', async () => {
    const { env } = makeEnv({
      'user:user-1': 'best_accuracy',
    });

    await expect(
      getAutoRoutingMode(env, { userId: 'user-1', organizationId: 'org-1' })
    ).resolves.toBe('best_accuracy');
  });

  it('reads the owner object on every lookup instead of serving a stale module value', async () => {
    const { env, modes, stubs } = makeEnv({
      'user:user-1': 'best_accuracy',
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
});
