import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import {
  AutoRoutingModeConfigDO,
  clearAutoRoutingSettingsCache,
  getConfiguredAutoRoutingMode,
  getConfiguredAutoRoutingSettings,
  getAutoRoutingMode,
  getEffectiveAutoRoutingSettings,
  setAutoRoutingMode,
  setAutoRoutingSettings,
} from './routing-mode';
import type {
  AutoRoutingMode,
  CustomRoutingTable,
  EfficientModelPool,
} from '@kilocode/auto-routing-contracts';
import type { AutoRoutingOwnerSettings } from './routing-mode';

type ModeStub = {
  getMode: ReturnType<typeof vi.fn<() => Promise<AutoRoutingMode | null>>>;
  setMode: ReturnType<typeof vi.fn<(mode: AutoRoutingMode | null) => Promise<void>>>;
  getPool: ReturnType<typeof vi.fn<() => Promise<EfficientModelPool | null>>>;
  setPool: ReturnType<typeof vi.fn<(pool: EfficientModelPool | null) => Promise<void>>>;
  getSettings: ReturnType<typeof vi.fn<() => Promise<AutoRoutingOwnerSettings>>>;
  setSettings: ReturnType<typeof vi.fn<(settings: AutoRoutingOwnerSettings) => Promise<void>>>;
  saveSettings: Mock<
    (request: {
      mode: AutoRoutingMode | null;
      pool: EfficientModelPool | null;
    }) => Promise<{ statuses: [] }>
  >;
};

const SAMPLE_POOL: EfficientModelPool = [{ model: 'a/chat' }, { model: 'b/chat' }];

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
      saveSettings: vi.fn(async request => {
        modes.set(id, request.mode);
        pools.set(id, request.pool);
        return { statuses: [] };
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

function applyPut(
  target: Map<string, unknown>,
  keyOrEntries: string | Record<string, unknown>,
  value?: unknown
) {
  if (typeof keyOrEntries === 'string') {
    target.set(keyOrEntries, value);
    return;
  }
  for (const [key, entryValue] of Object.entries(keyOrEntries)) {
    target.set(key, entryValue);
  }
}

function applyDelete(target: Map<string, unknown>, keyOrKeys: string | string[]) {
  if (typeof keyOrKeys === 'string') {
    target.delete(keyOrKeys);
    return;
  }
  for (const key of keyOrKeys) {
    target.delete(key);
  }
}

function createFakeStorage() {
  const entries = new Map<string, unknown>();

  const storage = {
    entries,
    get: async (key: string) => entries.get(key),
    put: async (keyOrEntries: string | Record<string, unknown>, value?: unknown) => {
      applyPut(entries, keyOrEntries, value);
    },
    delete: async (keyOrKeys: string | string[]) => {
      applyDelete(entries, keyOrKeys);
    },
    transaction: async <T>(
      callback: (txn: {
        put: (keyOrEntries: string | Record<string, unknown>, value?: unknown) => Promise<void>;
        delete: (keyOrKeys: string | string[]) => Promise<void>;
        get: (key: string) => Promise<unknown>;
      }) => Promise<T>
    ): Promise<T> => {
      const shadow = new Map(entries);
      const txn = {
        get: async (key: string) => shadow.get(key),
        put: async (keyOrEntries: string | Record<string, unknown>, value?: unknown) => {
          applyPut(shadow, keyOrEntries, value);
        },
        delete: async (keyOrKeys: string | string[]) => {
          applyDelete(shadow, keyOrKeys);
        },
      };
      const result = await callback(txn);
      entries.clear();
      for (const [key, value] of shadow) {
        entries.set(key, value);
      }
      return result;
    },
  };

  return storage;
}

function createModeDO(env: Partial<Env> = {}) {
  const storage = createFakeStorage();
  const modeDO = new AutoRoutingModeConfigDO(
    { storage } as unknown as DurableObjectState,
    env as Env
  );
  return { modeDO, storage };
}

type SubscriptionRequest = {
  ownerType: 'user' | 'org';
  ownerId: string;
  entries: EfficientModelPool | null;
  restorePrevious?: boolean;
};

function createSubscriptionDO() {
  const state: {
    subscriptions: EfficientModelPool | null;
    table: CustomRoutingTable | null;
  } = { subscriptions: null, table: null };
  const requests: { path: string; body: SubscriptionRequest }[] = [];
  const respond = async (path: string, body: SubscriptionRequest) => {
    if (path === '/admin/profiles/subscriptions' || path === '/admin/profiles/register') {
      state.subscriptions = body.entries;
    }
    if (path === '/admin/custom-routing-table') {
      return Response.json({ table: state.table });
    }
    return Response.json({
      statuses: (body.entries ?? []).map(entry => ({
        entry: { ...entry, variant: null },
        status: 'ready',
      })),
    });
  };
  const handle = vi.fn(respond);
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    if (typeof init?.body !== 'string') throw new Error('Expected serialized benchmark request');
    const body = JSON.parse(init.body) as SubscriptionRequest;
    const path = new URL(url).pathname;
    requests.push({ path, body });
    return handle(path, body);
  });
  const { modeDO, storage } = createModeDO({
    INTERNAL_API_SECRET_PROD: { get: async () => 'test-secret' } as Env['INTERNAL_API_SECRET_PROD'],
    BENCHMARK_SERVICE: { fetch } as unknown as Env['BENCHMARK_SERVICE'],
  });
  return { modeDO, storage, state, requests, handle, respond };
}

describe('owner benchmark subscriptions', () => {
  const owner = { ownerType: 'user' as const, ownerId: 'user-1' };
  const aliases: EfficientModelPool = [{ model: '~vendor/model-latest' }];

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reads no-pool settings and saves only the mode without a benchmark dependency', async () => {
    const { modeDO, handle, requests } = createSubscriptionDO();
    handle.mockRejectedValue(new Error('benchmark unavailable'));
    await expect(modeDO.getSubscribedSettings(owner)).resolves.toEqual({
      settings: { mode: null, pool: null },
      statuses: [],
    });
    await expect(
      modeDO.saveSettings({ ...owner, mode: 'best_accuracy', pool: null })
    ).resolves.toEqual({ statuses: [] });
    expect(await modeDO.getCustomRoutingTable(owner)).toBeNull();
    expect(await modeDO.getSettings()).toEqual({ mode: 'best_accuracy', pool: null });
    expect(requests).toEqual([]);
  });

  it('does not synchronize or re-register an unchanged pool on a mode-only save', async () => {
    const { modeDO, handle, requests } = createSubscriptionDO();
    await modeDO.setSettings({ mode: null, pool: aliases });
    handle.mockRejectedValue(new Error('benchmark unavailable'));
    await expect(
      modeDO.saveSettings({ ...owner, mode: 'best_accuracy', pool: aliases })
    ).resolves.toEqual({ statuses: [] });
    expect(await modeDO.getSettings()).toEqual({ mode: 'best_accuracy', pool: aliases });
    expect(requests).toEqual([]);
  });

  it('bootstraps historical aliases on every settings read without rewriting the saved pool', async () => {
    const { modeDO, storage, requests } = createSubscriptionDO();
    await modeDO.setSettings({ mode: 'best_accuracy', pool: aliases });

    const first = await modeDO.getSubscribedSettings(owner);
    const second = await modeDO.getSubscribedSettings(owner);

    expect(first.settings).toEqual({ mode: 'best_accuracy', pool: aliases });
    expect(second).toEqual(first);
    expect(storage.entries.get('pool')).toEqual(aliases);
    expect(requests).toEqual([
      { path: '/admin/profiles/subscriptions', body: { ...owner, entries: aliases } },
      {
        path: '/admin/profiles/status',
        body: { router: 'efficient', ...owner, entries: aliases },
      },
      { path: '/admin/profiles/subscriptions', body: { ...owner, entries: aliases } },
      {
        path: '/admin/profiles/status',
        body: { router: 'efficient', ...owner, entries: aliases },
      },
    ]);
  });

  it('bootstraps the previous pool before replacement and clears subscriptions on removal', async () => {
    const { modeDO, state, requests } = createSubscriptionDO();
    await modeDO.setSettings({ mode: null, pool: aliases });
    const replacement: EfficientModelPool = [{ model: '~vendor/other-latest' }];

    await modeDO.saveSettings({ ...owner, mode: 'best_accuracy', pool: replacement });
    expect(state.subscriptions).toEqual(replacement);
    expect(requests.slice(0, 2)).toEqual([
      { path: '/admin/profiles/subscriptions', body: { ...owner, entries: aliases } },
      {
        path: '/admin/profiles/register',
        body: { router: 'efficient', ...owner, entries: replacement },
      },
    ]);

    requests.length = 0;
    await modeDO.saveSettings({ ...owner, mode: null, pool: null });
    expect(state.subscriptions).toBeNull();
    expect(await modeDO.getCustomRoutingTable(owner)).toBeNull();
    expect(requests.every(request => request.path === '/admin/profiles/subscriptions')).toBe(true);
    expect(await modeDO.getSettings()).toEqual({ mode: null, pool: null });
  });

  it('reads an existing owner serving table without synchronizing subscriptions', async () => {
    const { modeDO, state, storage, requests } = createSubscriptionDO();
    await modeDO.setSettings({ mode: null, pool: aliases });
    const table: CustomRoutingTable = {
      version: 'old-active',
      generatedAt: '2026-10-01T00:00:00.000Z',
      minAccuracy: 0.7,
      switchCostFactor: 3,
      bestAccuracySwitchThreshold: 0.05,
      source: 'benchmark',
      routes: {
        'implementation/feature_development': [
          {
            model: 'vendor/old',
            variant: null,
            accuracy: 0.9,
            avgCostUsd: 0.001,
            meetsThreshold: true,
          },
        ],
      },
    };
    state.table = table;

    expect(await modeDO.getCustomRoutingTable(owner)).toEqual(table);
    expect(requests).toEqual([
      {
        path: '/admin/custom-routing-table',
        body: { router: 'efficient', ...owner, entries: aliases },
      },
    ]);
    expect(storage.entries.get('pool')).toEqual(aliases);
  });

  it('bootstraps a missing subscription from the saved pool and retries table assembly', async () => {
    const { modeDO, state, requests, handle, respond } = createSubscriptionDO();
    await modeDO.setSettings({ mode: null, pool: aliases });
    handle.mockImplementation(async (path, body) => {
      if (path === '/admin/custom-routing-table' && state.subscriptions === null) {
        return Response.json({ table: null });
      }
      return respond(path, body);
    });

    expect(await modeDO.getCustomRoutingTable(owner)).toBeNull();
    expect(state.subscriptions).toEqual(aliases);
    expect(requests.map(request => request.path)).toEqual([
      '/admin/custom-routing-table',
      '/admin/profiles/subscriptions',
      '/admin/custom-routing-table',
    ]);
  });

  it('leaves saved settings unchanged when historical bootstrap fails', async () => {
    const { modeDO, handle, requests } = createSubscriptionDO();
    await modeDO.setSettings({ mode: 'best_accuracy', pool: aliases });
    handle.mockRejectedValueOnce(new Error('bootstrap unavailable'));

    await expect(modeDO.saveSettings({ ...owner, mode: null, pool: SAMPLE_POOL })).rejects.toThrow(
      'bootstrap unavailable'
    );

    expect(await modeDO.getSettings()).toEqual({ mode: 'best_accuracy', pool: aliases });
    expect(requests.map(request => request.path)).toEqual(['/admin/profiles/subscriptions']);
  });

  it('restores the saved subscriptions after an ambiguous register failure', async () => {
    const { modeDO, handle, respond, state, requests } = createSubscriptionDO();
    await modeDO.setSettings({ mode: 'best_accuracy', pool: aliases });
    handle.mockImplementation(async (path, body) => {
      const response = await respond(path, body);
      if (path === '/admin/profiles/register') throw new Error('register response lost');
      return response;
    });

    await expect(modeDO.saveSettings({ ...owner, mode: null, pool: SAMPLE_POOL })).rejects.toThrow(
      'register response lost'
    );

    expect(state.subscriptions).toEqual(aliases);
    expect(await modeDO.getSettings()).toEqual({ mode: 'best_accuracy', pool: aliases });
    expect(requests.at(-1)).toEqual({
      path: '/admin/profiles/subscriptions',
      body: { ...owner, entries: aliases, restorePrevious: true },
    });
  });

  it('restores subscriptions when the local settings commit fails', async () => {
    const { modeDO, state } = createSubscriptionDO();
    await modeDO.setSettings({ mode: 'best_accuracy', pool: aliases });
    vi.spyOn(modeDO, 'setSettings').mockRejectedValueOnce(new Error('storage unavailable'));

    await expect(modeDO.saveSettings({ ...owner, mode: null, pool: null })).rejects.toThrow(
      'storage unavailable'
    );

    expect(state.subscriptions).toEqual(aliases);
    expect(await modeDO.getSettings()).toEqual({ mode: 'best_accuracy', pool: aliases });
  });

  it('does not clear the saved pool when removal fails and allows a later retry', async () => {
    const { modeDO, handle, respond, state } = createSubscriptionDO();
    await modeDO.setSettings({ mode: 'best_accuracy', pool: aliases });
    handle.mockImplementationOnce(respond).mockRejectedValueOnce(new Error('removal unavailable'));

    await expect(modeDO.saveSettings({ ...owner, mode: null, pool: null })).rejects.toThrow(
      'removal unavailable'
    );
    expect(state.subscriptions).toEqual(aliases);
    expect(await modeDO.getSettings()).toEqual({ mode: 'best_accuracy', pool: aliases });

    await modeDO.saveSettings({ ...owner, mode: null, pool: null });
    expect(state.subscriptions).toBeNull();
    expect(await modeDO.getSettings()).toEqual({ mode: null, pool: null });
  });

  it('serializes concurrent saves and reads so an old bootstrap cannot restore a removed pool', async () => {
    const { modeDO, handle, respond, state, requests } = createSubscriptionDO();
    await modeDO.setSettings({ mode: null, pool: aliases });
    let releaseBootstrap: (() => void) | undefined;
    let notifyStarted: (() => void) | undefined;
    const started = new Promise<void>(resolve => {
      notifyStarted = resolve;
    });
    const blocked = new Promise<void>(resolve => {
      releaseBootstrap = resolve;
    });
    handle.mockImplementationOnce(async (path, body) => {
      notifyStarted?.();
      await blocked;
      return respond(path, body);
    });

    const oldRead = modeDO.getSubscribedSettings(owner);
    await started;
    const replacement = modeDO.saveSettings({ ...owner, mode: 'best_accuracy', pool: SAMPLE_POOL });
    const removal = modeDO.saveSettings({ ...owner, mode: null, pool: null });
    const finalRead = modeDO.getSubscribedSettings(owner);
    expect(requests).toHaveLength(1);
    releaseBootstrap?.();
    await Promise.all([oldRead, replacement, removal, finalRead]);

    expect(state.subscriptions).toBeNull();
    expect(await modeDO.getSettings()).toEqual({ mode: null, pool: null });
    expect(requests.at(-1)).toEqual({
      path: '/admin/profiles/subscriptions',
      body: { ...owner, entries: null },
    });
  });
});

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
    const putCalls: unknown[] = [];
    const deleteCalls: unknown[] = [];
    const originalTransaction = storage.transaction.bind(storage);
    const transactionSpy = vi.spyOn(storage, 'transaction').mockImplementation(async callback =>
      originalTransaction(async txn => {
        const put = txn.put.bind(txn);
        const del = txn.delete.bind(txn);
        txn.put = async (keyOrEntries, value?) => {
          putCalls.push(keyOrEntries);
          return put(keyOrEntries, value);
        };
        txn.delete = async keyOrKeys => {
          deleteCalls.push(keyOrKeys);
          return del(keyOrKeys);
        };
        return callback(txn);
      })
    );

    await modeDO.setSettings({ mode: 'best_accuracy', pool: SAMPLE_POOL });
    expect(transactionSpy).toHaveBeenCalledTimes(1);
    expect(putCalls).toEqual([{ mode: 'best_accuracy', pool: SAMPLE_POOL }]);
    expect(deleteCalls).toEqual([]);

    putCalls.length = 0;
    deleteCalls.length = 0;
    transactionSpy.mockClear();
    await modeDO.setSettings({ mode: null, pool: null });
    expect(transactionSpy).toHaveBeenCalledTimes(1);
    expect(deleteCalls).toEqual([['mode', 'pool']]);
    expect(putCalls).toEqual([]);

    putCalls.length = 0;
    deleteCalls.length = 0;
    transactionSpy.mockClear();
    await modeDO.setSettings({ mode: 'cost_per_accuracy', pool: null });
    expect(transactionSpy).toHaveBeenCalledTimes(1);
    expect(putCalls).toEqual([{ mode: 'cost_per_accuracy' }]);
    expect(deleteCalls).toEqual([['pool']]);
  });

  it('rolls back mode and pool when a transactional delete fails', async () => {
    const { modeDO, storage } = createModeDO();
    await modeDO.setSettings({ mode: 'best_accuracy', pool: SAMPLE_POOL });

    const originalTransaction = storage.transaction.bind(storage);
    vi.spyOn(storage, 'transaction').mockImplementation(async callback =>
      originalTransaction(async txn => {
        txn.delete = async () => {
          throw new Error('delete failed');
        };
        return callback(txn);
      })
    );

    await expect(modeDO.setSettings({ mode: 'cost_per_accuracy', pool: null })).rejects.toThrow(
      'delete failed'
    );
    expect(storage.entries.get('mode')).toBe('best_accuracy');
    expect(storage.entries.get('pool')).toEqual(SAMPLE_POOL);
    await expect(modeDO.getSettings()).resolves.toEqual({
      mode: 'best_accuracy',
      pool: SAMPLE_POOL,
    });
  });

  it('atomically commits a mixed mode write and pool delete', async () => {
    const { modeDO, storage } = createModeDO();
    await modeDO.setSettings({ mode: 'best_accuracy', pool: SAMPLE_POOL });

    await modeDO.setSettings({ mode: 'cost_per_accuracy', pool: null });

    expect(storage.entries.get('mode')).toBe('cost_per_accuracy');
    expect(storage.entries.has('pool')).toBe(false);
    await expect(modeDO.getSettings()).resolves.toEqual({
      mode: 'cost_per_accuracy',
      pool: null,
    });
  });

  it('lazily persists model-only pools from legacy effort entries', async () => {
    const { modeDO, storage } = createModeDO();
    storage.entries.set('pool', [
      { model: 'a/chat', variant: 'thinking' },
      { model: 'a/chat', variant: 'max' },
      { model: 'b/chat', variant: null },
    ]);
    await expect(modeDO.getPool()).resolves.toEqual(SAMPLE_POOL);
    expect(storage.entries.get('pool')).toEqual(SAMPLE_POOL);
  });

  it('returns the normalized pool and configured mode when normalization cannot be stored', async () => {
    const { modeDO, storage } = createModeDO();
    const legacyPool = [
      { model: 'a/chat', variant: 'thinking' },
      { model: 'a/chat', variant: 'max' },
      { model: 'b/chat', variant: null },
    ];
    storage.entries.set('mode', 'best_accuracy');
    storage.entries.set('pool', legacyPool);

    const put = vi.fn(async () => {
      throw new Error('put failed');
    });
    const originalTransaction = storage.transaction.bind(storage);
    vi.spyOn(storage, 'transaction').mockImplementation(async callback =>
      originalTransaction(async txn => {
        txn.put = put;
        return callback(txn);
      })
    );

    await expect(modeDO.getPool()).resolves.toEqual(SAMPLE_POOL);
    await expect(modeDO.getSettings()).resolves.toEqual({
      mode: 'best_accuracy',
      pool: SAMPLE_POOL,
    });
    expect(put).toHaveBeenCalledTimes(2);
    expect(put).toHaveBeenCalledWith('pool', SAMPLE_POOL);
    expect(storage.entries.get('mode')).toBe('best_accuracy');
    expect(storage.entries.get('pool')).toEqual(legacyPool);
  });
});

describe('auto routing mode config', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearAutoRoutingSettingsCache();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
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

  it('bounds cached owner settings by the TTL and clears them on demand', async () => {
    vi.useFakeTimers();
    const { env, modes, pools, stubs } = makeEnv({
      'user:user-1': { mode: 'best_accuracy', pool: SAMPLE_POOL },
    });
    const owner = { userId: 'user-1', organizationId: null };

    await expect(getEffectiveAutoRoutingSettings(env, owner)).resolves.toEqual({
      mode: 'best_accuracy',
      pool: SAMPLE_POOL,
      poolOwner: { ownerType: 'user', ownerId: 'user-1' },
    });

    modes.set('user:user-1', 'cost_per_accuracy');
    pools.set('user:user-1', null);
    vi.advanceTimersByTime(29_999);

    await expect(getEffectiveAutoRoutingSettings(env, owner)).resolves.toEqual({
      mode: 'best_accuracy',
      pool: SAMPLE_POOL,
      poolOwner: { ownerType: 'user', ownerId: 'user-1' },
    });
    expect(stubs.get('user:user-1')?.getSettings).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1);
    await expect(getEffectiveAutoRoutingSettings(env, owner)).resolves.toEqual({
      mode: 'cost_per_accuracy',
      pool: null,
      poolOwner: null,
    });
    expect(stubs.get('user:user-1')?.getSettings).toHaveBeenCalledTimes(2);

    modes.set('user:user-1', 'best_accuracy');
    clearAutoRoutingSettingsCache();
    await expect(getEffectiveAutoRoutingSettings(env, owner)).resolves.toEqual({
      mode: 'best_accuracy',
      pool: null,
      poolOwner: null,
    });
    expect(stubs.get('user:user-1')?.getSettings).toHaveBeenCalledTimes(3);
  });

  it('shares organization settings without mixing personal settings across users', async () => {
    const { env, stubs } = makeEnv({
      'user:user-1': { mode: 'best_accuracy' },
      'user:user-2': { mode: 'cost_per_accuracy' },
      'org:org-1': { pool: SAMPLE_POOL },
    });

    await expect(
      getEffectiveAutoRoutingSettings(env, { userId: 'user-1', organizationId: 'org-1' })
    ).resolves.toEqual({
      mode: 'best_accuracy',
      pool: SAMPLE_POOL,
      poolOwner: { ownerType: 'org', ownerId: 'org-1' },
    });
    await expect(
      getEffectiveAutoRoutingSettings(env, { userId: 'user-2', organizationId: 'org-1' })
    ).resolves.toEqual({
      mode: 'cost_per_accuracy',
      pool: SAMPLE_POOL,
      poolOwner: { ownerType: 'org', ownerId: 'org-1' },
    });
    expect(stubs.get('org:org-1')?.getSettings).toHaveBeenCalledTimes(1);
  });

  it('retries failed owner settings reads on the next lookup', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { env, stubs } = makeEnv({
      'user:user-1': { mode: 'best_accuracy', pool: SAMPLE_POOL },
    });
    const owner = { userId: 'user-1', organizationId: null };
    await getConfiguredAutoRoutingSettings(env, { ownerType: 'user', ownerId: 'user-1' });
    stubs.get('user:user-1')?.getSettings.mockClear();
    stubs.get('user:user-1')?.getSettings.mockRejectedValueOnce(new Error('do unavailable'));

    await expect(getEffectiveAutoRoutingSettings(env, owner)).resolves.toEqual({
      mode: 'cost_per_accuracy',
      pool: null,
      poolOwner: null,
    });
    await expect(getEffectiveAutoRoutingSettings(env, owner)).resolves.toEqual({
      mode: 'best_accuracy',
      pool: SAMPLE_POOL,
      poolOwner: { ownerType: 'user', ownerId: 'user-1' },
    });
    expect(stubs.get('user:user-1')?.getSettings).toHaveBeenCalledTimes(2);
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
      poolOwner: { ownerType: 'org', ownerId: 'org-1' },
    });
  });

  it('resolves mode and pool independently (org mode + personal pool)', async () => {
    const personalPool: EfficientModelPool = [{ model: 'personal/chat' }];
    const { env } = makeEnv({
      'user:user-1': { mode: null, pool: personalPool },
      'org:org-1': { mode: 'best_accuracy', pool: null },
    });

    await expect(
      getEffectiveAutoRoutingSettings(env, { userId: 'user-1', organizationId: 'org-1' })
    ).resolves.toEqual({
      mode: 'best_accuracy',
      pool: personalPool,
      poolOwner: { ownerType: 'user', ownerId: 'user-1' },
    });
  });

  it('lets org pool override personal pool and clearing restore inheritance', async () => {
    const personalPool: EfficientModelPool = [{ model: 'personal/chat' }];
    const orgPool: EfficientModelPool = [{ model: 'org/chat' }];
    const { env, modes, pools } = makeEnv({
      'user:user-1': { mode: 'cost_per_accuracy', pool: personalPool },
      'org:org-1': { mode: null, pool: orgPool },
    });

    await expect(
      getEffectiveAutoRoutingSettings(env, { userId: 'user-1', organizationId: 'org-1' })
    ).resolves.toEqual({
      mode: 'cost_per_accuracy',
      pool: orgPool,
      poolOwner: { ownerType: 'org', ownerId: 'org-1' },
    });

    pools.set('org:org-1', null);
    modes.set('org:org-1', null);
    clearAutoRoutingSettingsCache();

    await expect(
      getEffectiveAutoRoutingSettings(env, { userId: 'user-1', organizationId: 'org-1' })
    ).resolves.toEqual({
      mode: 'cost_per_accuracy',
      pool: personalPool,
      poolOwner: { ownerType: 'user', ownerId: 'user-1' },
    });
  });

  it('writes combined settings through the owner stub', async () => {
    const { env, modes, pools, stubs } = makeEnv();

    await setAutoRoutingSettings(env, {
      ownerType: 'user',
      ownerId: 'user-1',
      mode: 'best_accuracy',
      pool: SAMPLE_POOL,
    });
    expect(modes.get('user:user-1')).toBe('best_accuracy');
    expect(pools.get('user:user-1')).toEqual(SAMPLE_POOL);
    expect(stubs.get('user:user-1')?.saveSettings).toHaveBeenCalledWith({
      ownerType: 'user',
      ownerId: 'user-1',
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
