import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AUTO_ROUTING_MODE_CONFIG_PREFIX,
  clearAutoRoutingModeCache,
  getConfiguredAutoRoutingMode,
  getAutoRoutingMode,
  setAutoRoutingMode,
} from './routing-mode';

type ModeEnvStub = Pick<Env, 'AUTO_ROUTING_CONFIG' | 'AUTO_ROUTING_DB'>;

function makeEnv(
  params: {
    kvValues?: Record<string, string | null>;
    dbValues?: Record<string, string | null>;
  } = {}
) {
  const kvValues = params.kvValues ?? {};
  const dbValues = params.dbValues ?? {};
  const configGet = vi.fn(async (key: string) => kvValues[key] ?? null);
  const configPut = vi.fn(async (key: string, value: string) => {
    kvValues[key] = value;
  });
  const configDelete = vi.fn(async (key: string) => {
    kvValues[key] = null;
  });
  const dbPrepare = vi.fn((sql: string) => ({
    bind: (...args: string[]) => ({
      first: vi.fn(async () => {
        if (!sql.startsWith('SELECT')) return null;
        const [ownerType, ownerId] = args;
        const mode = dbValues[`${ownerType}:${ownerId}`] ?? null;
        return mode ? { mode } : null;
      }),
      run: vi.fn(async () => {
        const [ownerType, ownerId, mode] = args;
        if (sql.startsWith('DELETE')) {
          dbValues[`${ownerType}:${ownerId}`] = null;
          return {};
        }
        dbValues[`${ownerType}:${ownerId}`] = mode;
        return {};
      }),
    }),
  }));
  const env = {
    AUTO_ROUTING_CONFIG: {
      get: configGet,
      put: configPut,
      delete: configDelete,
    },
    AUTO_ROUTING_DB: {
      prepare: dbPrepare,
    },
  } as unknown as ModeEnvStub;

  return { env, configGet, configPut, configDelete, dbPrepare, kvValues, dbValues };
}

describe('auto routing mode config', () => {
  beforeEach(() => {
    clearAutoRoutingModeCache();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('defaults to least cost per accuracy when no owner config exists', async () => {
    const { env } = makeEnv();

    await expect(getAutoRoutingMode(env, { userId: 'user-1', organizationId: null })).resolves.toBe(
      'cost_per_accuracy'
    );
  });

  it('uses organization mode before user mode', async () => {
    const { env, configGet } = makeEnv({
      kvValues: {
        [`${AUTO_ROUTING_MODE_CONFIG_PREFIX}:user:user-1`]: 'best_accuracy',
        [`${AUTO_ROUTING_MODE_CONFIG_PREFIX}:org:org-1`]: 'cost_per_accuracy',
      },
    });

    await expect(
      getAutoRoutingMode(env, { userId: 'user-1', organizationId: 'org-1' })
    ).resolves.toBe('cost_per_accuracy');
    expect(configGet).toHaveBeenNthCalledWith(1, `${AUTO_ROUTING_MODE_CONFIG_PREFIX}:org:org-1`);
  });

  it('falls back to user mode when organization mode is absent', async () => {
    const { env } = makeEnv({
      kvValues: {
        [`${AUTO_ROUTING_MODE_CONFIG_PREFIX}:user:user-1`]: 'best_accuracy',
      },
    });

    await expect(
      getAutoRoutingMode(env, { userId: 'user-1', organizationId: 'org-1' })
    ).resolves.toBe('best_accuracy');
  });

  it('reads through D1 after a KV miss', async () => {
    const { env, configPut, dbPrepare } = makeEnv({
      dbValues: {
        'user:user-1': 'best_accuracy',
      },
    });

    await expect(getAutoRoutingMode(env, { userId: 'user-1', organizationId: null })).resolves.toBe(
      'best_accuracy'
    );
    expect(dbPrepare).toHaveBeenCalledWith(
      'SELECT mode FROM auto_routing_modes WHERE owner_type = ? AND owner_id = ? LIMIT 1'
    );
    expect(configPut).toHaveBeenCalledWith(
      `${AUTO_ROUTING_MODE_CONFIG_PREFIX}:user:user-1`,
      'best_accuracy',
      { expirationTtl: 60 }
    );
  });

  it('returns the D1 mode when read-through cache population fails', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { env, configPut } = makeEnv({
      dbValues: {
        'user:user-1': 'best_accuracy',
      },
    });
    configPut.mockRejectedValueOnce(new Error('kv unavailable'));

    await expect(getAutoRoutingMode(env, { userId: 'user-1', organizationId: null })).resolves.toBe(
      'best_accuracy'
    );
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('auto_routing_config_cache_write_failed')
    );
  });

  it('ignores invalid cached values and returns the default mode', async () => {
    const { env, configPut } = makeEnv({
      kvValues: {
        [`${AUTO_ROUTING_MODE_CONFIG_PREFIX}:user:user-1`]: 'fastest',
      },
    });

    await expect(getAutoRoutingMode(env, { userId: 'user-1', organizationId: null })).resolves.toBe(
      'cost_per_accuracy'
    );
    expect(configPut).toHaveBeenCalledWith(
      `${AUTO_ROUTING_MODE_CONFIG_PREFIX}:user:user-1`,
      '__default__',
      { expirationTtl: 60 }
    );
  });

  it('uses the cached null sentinel without hitting D1', async () => {
    const { env, dbPrepare } = makeEnv({
      kvValues: {
        [`${AUTO_ROUTING_MODE_CONFIG_PREFIX}:user:user-1`]: '__default__',
      },
      dbValues: {
        'user:user-1': 'best_accuracy',
      },
    });

    await expect(
      getConfiguredAutoRoutingMode(env, { ownerType: 'user', ownerId: 'user-1' })
    ).resolves.toBe(null);
    expect(dbPrepare).not.toHaveBeenCalled();
  });

  it('writes and clears owner-specific modes in D1 and cache', async () => {
    const { env, configPut, dbValues } = makeEnv();

    await setAutoRoutingMode(env, { ownerType: 'org', ownerId: 'org-1' }, 'best_accuracy');
    expect(dbValues['org:org-1']).toBe('best_accuracy');
    expect(configPut).toHaveBeenCalledWith(
      `${AUTO_ROUTING_MODE_CONFIG_PREFIX}:org:org-1`,
      'best_accuracy',
      { expirationTtl: 60 }
    );

    await setAutoRoutingMode(env, { ownerType: 'org', ownerId: 'org-1' }, null);
    expect(dbValues['org:org-1']).toBeNull();
    expect(configPut).toHaveBeenLastCalledWith(
      `${AUTO_ROUTING_MODE_CONFIG_PREFIX}:org:org-1`,
      '__default__',
      { expirationTtl: 60 }
    );
  });

  it('does not fail a D1-backed mode write when cache update fails', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { env, configPut, dbValues } = makeEnv();
    configPut.mockRejectedValueOnce(new Error('kv unavailable'));

    await expect(
      setAutoRoutingMode(env, { ownerType: 'org', ownerId: 'org-1' }, 'best_accuracy')
    ).resolves.toBeUndefined();

    expect(dbValues['org:org-1']).toBe('best_accuracy');
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('auto_routing_config_cache_write_failed')
    );
  });
});
