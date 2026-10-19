import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_AUTO_ROUTING_MODE, type AutoRoutingMode } from '@kilocode/auto-routing-contracts';
import {
  AutoRoutingModeConfigDO,
  getAutoRoutingMode,
  getConfiguredAutoRoutingMode,
  setAutoRoutingMode,
} from './routing-mode';

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
  };
  const modeDO = new AutoRoutingModeConfigDO(
    { storage } as unknown as DurableObjectState,
    {} as Env
  );
  return { modeDO, storage, entries };
}

describe('AutoRoutingModeConfigDO', () => {
  it.each([{ mode: 'best_accuracy' }, { mode: 'best_accuracy', pool: [{ model: 'a/chat' }] }])(
    'preserves saved owner modes independently of the pool: %j',
    async initial => {
      const { modeDO } = createModeDO(initial);
      await expect(modeDO.getMode()).resolves.toBe('best_accuracy');
      await modeDO.setMode('cost_per_accuracy');
      await expect(modeDO.getMode()).resolves.toBe('cost_per_accuracy');
      await modeDO.setMode(null);
      await expect(modeDO.getMode()).resolves.toBeNull();
    }
  );

  it.each(['conversionPending', 'poolMigratedAt'])(
    'allows mode updates and resets after %s without changing the frozen pool snapshot',
    async marker => {
      const pool = [{ model: 'a/chat' }];
      const snapshot = { mode: 'best_accuracy', pool };
      const markerValue = marker === 'conversionPending' ? snapshot : '2026-10-18T00:00:00.000Z';
      const { modeDO, entries } = createModeDO({
        mode: 'best_accuracy',
        pool,
        [marker]: markerValue,
      });

      await modeDO.setMode('cost_per_accuracy');
      await expect(modeDO.getMode()).resolves.toBe('cost_per_accuracy');
      expect(entries.get(marker)).toEqual(markerValue);
      expect(entries.get('pool')).toEqual(pool);

      await modeDO.setMode(null);
      await expect(modeDO.getMode()).resolves.toBeNull();
      expect(entries.has('mode')).toBe(false);
      expect(entries.get(marker)).toEqual(markerValue);
    }
  );

  it('treats invalid saved modes as unconfigured', async () => {
    const { modeDO } = createModeDO({ mode: 'fastest' });
    await expect(modeDO.getMode()).resolves.toBeNull();
  });
});

describe('platform routing mode precedence', () => {
  function modeEnv(modes: Record<string, AutoRoutingMode | null>) {
    const getMode = vi.fn(async (key: string) => modes[key] ?? null);
    const setMode = vi.fn(async (key: string, mode: AutoRoutingMode | null) => {
      modes[key] = mode;
    });
    const idFromName = vi.fn((name: string) => name);
    const env = {
      AUTO_ROUTING_MODE_CONFIG: {
        idFromName,
        get: (key: string) => ({
          getMode: () => getMode(key),
          setMode: (mode: AutoRoutingMode | null) => setMode(key, mode),
        }),
      },
    } as unknown as Pick<Env, 'AUTO_ROUTING_MODE_CONFIG'>;
    return { env, getMode, setMode, idFromName };
  }

  it.each([
    { user: null, org: null, expected: DEFAULT_AUTO_ROUTING_MODE },
    { user: 'best_accuracy', org: null, expected: 'best_accuracy' },
    { user: null, org: 'best_accuracy', expected: 'best_accuracy' },
    { user: 'best_accuracy', org: 'cost_per_accuracy', expected: 'cost_per_accuracy' },
    { user: 'cost_per_accuracy', org: 'best_accuracy', expected: 'best_accuracy' },
  ] satisfies {
    user: AutoRoutingMode | null;
    org: AutoRoutingMode | null;
    expected: AutoRoutingMode;
  }[])('resolves organization > personal > default: %j', async ({ user, org, expected }) => {
    const { env, getMode } = modeEnv({ 'user:user-1': user, 'org:org-1': org });
    await expect(
      getAutoRoutingMode(env, { userId: 'user-1', organizationId: 'org-1' })
    ).resolves.toBe(expected);
    expect(getMode).toHaveBeenCalledWith('user:user-1');
    expect(getMode).toHaveBeenCalledWith('org:org-1');
  });

  it('uses personal mode without an organization and returns configured null without defaulting', async () => {
    const { env, idFromName } = modeEnv({ 'user:user-1': 'best_accuracy' });
    await expect(getAutoRoutingMode(env, { userId: 'user-1', organizationId: null })).resolves.toBe(
      'best_accuracy'
    );
    await expect(
      getConfiguredAutoRoutingMode(env, { ownerType: 'org', ownerId: 'org-1' })
    ).resolves.toBeNull();
    expect(idFromName.mock.calls).toEqual([['user:user-1'], ['org:org-1']]);
  });

  it('restores personal inheritance when the organization mode is cleared', async () => {
    const { env } = modeEnv({
      'user:user-1': 'best_accuracy',
      'org:org-1': 'cost_per_accuracy',
    });
    const owner = { userId: 'user-1', organizationId: 'org-1' };
    await expect(getAutoRoutingMode(env, owner)).resolves.toBe('cost_per_accuracy');
    await setAutoRoutingMode(env, { ownerType: 'org', ownerId: 'org-1' }, null);
    await expect(getAutoRoutingMode(env, owner)).resolves.toBe('best_accuracy');
  });

  it('keeps the personal mode when the organization mode read fails', async () => {
    const { env, getMode } = modeEnv({ 'user:user-1': 'best_accuracy' });
    getMode.mockImplementation(async key => {
      if (key.startsWith('org:')) throw new Error('mode unavailable');
      return 'best_accuracy';
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await expect(
        getAutoRoutingMode(env, { userId: 'user-1', organizationId: 'org-1' })
      ).resolves.toBe('best_accuracy');
      expect(warn).toHaveBeenCalledOnce();
    } finally {
      warn.mockRestore();
    }
  });
});
