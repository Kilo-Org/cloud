import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import {
  OwnerPoolConversionRequestSchema,
  convertedOwnerPoolRouter,
  type AutoRoutingMode,
  type OwnerPoolConversionOutcome,
} from '@kilocode/auto-routing-contracts';
import type * as DbModule from '@kilocode/db';
import type { AutoRoutingCustomRouter } from '@kilocode/db';
import { getRoutingSettingsHandler, putRoutingSettingsHandler } from './admin-routing-settings';
import { AutoRoutingModeConfigDO } from './routing-mode';
import { migrateOwnerPoolForSettings, postOwnerPoolConversions } from './owner-pool-conversion';
import type { HonoEnv } from './hono-env';

const getWorkerDb = vi.hoisted(() => vi.fn());
vi.mock('@kilocode/db', async importOriginal => ({
  ...(await importOriginal<typeof DbModule>()),
  getWorkerDb,
}));

const app = new Hono<HonoEnv>();
app.get('/settings', getRoutingSettingsHandler);
app.put('/settings', putRoutingSettingsHandler);

function createStorage() {
  const entries = new Map<string, unknown>();
  let transactions: Promise<unknown> = Promise.resolve();
  const storage = {
    get: async (key: string | string[]) =>
      Array.isArray(key)
        ? new Map(key.filter(name => entries.has(name)).map(name => [name, entries.get(name)]))
        : entries.get(key),
    put: async (key: string, value: unknown) => {
      entries.set(key, value);
    },
    delete: async (key: string) => {
      entries.delete(key);
    },
    transaction: <T>(work: (txn: DurableObjectTransaction) => Promise<T>): Promise<T> => {
      const result = transactions.then(async () => {
        const shadow = new Map(entries);
        const txn = {
          get: async (key: string | string[]) =>
            Array.isArray(key)
              ? new Map(key.filter(name => shadow.has(name)).map(name => [name, shadow.get(name)]))
              : shadow.get(key),
          put: async (key: string | Record<string, unknown>, value?: unknown) => {
            if (typeof key === 'string') shadow.set(key, value);
            else for (const [name, stored] of Object.entries(key)) shadow.set(name, stored);
          },
          delete: async (key: string | string[]) => {
            for (const name of typeof key === 'string' ? [key] : key) shadow.delete(name);
          },
        };
        const value = await work(txn as unknown as DurableObjectTransaction);
        entries.clear();
        for (const [name, stored] of shadow) entries.set(name, stored);
        return value;
      });
      transactions = result.catch(() => {});
      return result;
    },
  };
  return { storage, entries };
}

let modeDO: AutoRoutingModeConfigDO;
let entries: Map<string, unknown>;
let canonical: AutoRoutingCustomRouter | null;
let outcome: OwnerPoolConversionOutcome;
const ownerLock = vi.fn();
const benchmarkFetch = vi.fn();
const webFetch = vi.fn<typeof fetch>();
const originalFetch = globalThis.fetch;
const owner = { ownerType: 'user', ownerId: 'owner-1' } as const;
const requestedPool = [{ model: 'requested/model' }];
const repairedPool = [{ model: 'repaired/model' }];
const env = {
  INTERNAL_API_SECRET_PROD: { get: async () => 'test-internal-secret' },
  KILO_WEB_API_BASE_URL: 'https://web.example.test',
  HYPERDRIVE: { connectionString: 'postgres://test' },
  BENCHMARK_SERVICE: { fetch: benchmarkFetch },
  AUTO_ROUTING_MODE_CONFIG: {
    idFromName: (name: string) => name,
    get: () => modeDO,
  },
};

async function convertRequest(_url: Parameters<typeof fetch>[0], init?: RequestInit) {
  if (typeof init?.body !== 'string') throw new Error('Expected serialized conversion');
  const conversion = OwnerPoolConversionRequestSchema.parse(JSON.parse(init.body)).conversions[0];
  if (!conversion) throw new Error('Expected one owner conversion');
  const result = canonical ? 'exists' : outcome;
  if (result === 'created') {
    const definition = convertedOwnerPoolRouter(conversion);
    canonical = {
      id: '11111111-1111-4111-8111-111111111111',
      owned_by_user_id: conversion.owner.id,
      owned_by_organization_id: null,
      created_by_user_id: null,
      slug: definition.slug,
      name: definition.name,
      base_router: definition.baseRouter,
      mode: definition.mode,
      entries: definition.entries,
      default_entry_key: definition.defaultEntryKey,
      legacy_pool: true,
      legacy_mode_inherited: conversion.configuredMode === null,
      created_at: '2026-10-18T00:00:00.000Z',
      updated_at: '2026-10-18T00:00:00.000Z',
    };
  }
  return Response.json({
    results: [
      {
        owner: conversion.owner,
        outcome: result,
        modelId: 'kilo-auto/custom/efficient',
        noticesSent: 0,
        noticesFailed: 0,
      },
    ],
  });
}

function putSettings(pool = requestedPool, mode: AutoRoutingMode | null = null) {
  return app.request(
    'https://worker.example.test/settings',
    {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...owner, mode, pool }),
    },
    env
  );
}

beforeEach(() => {
  const fake = createStorage();
  entries = fake.entries;
  modeDO = new AutoRoutingModeConfigDO(
    { storage: fake.storage } as unknown as DurableObjectState,
    {} as Env
  );
  canonical = null;
  outcome = 'created';
  ownerLock.mockReset().mockResolvedValue(undefined);
  benchmarkFetch.mockReset().mockImplementation(async () => Response.json({ statuses: [] }));
  webFetch.mockReset().mockImplementation(convertRequest);
  globalThis.fetch = webFetch;
  const select = () => ({
    from: () => ({ where: () => ({ limit: async () => (canonical ? [canonical] : []) }) }),
  });
  const tx = {
    execute: ownerLock,
    select,
    update: () => ({
      set: (values: Partial<AutoRoutingCustomRouter>) => ({
        where: () => ({
          returning: async () => {
            if (!canonical) return [];
            canonical = { ...canonical, ...values };
            return [canonical];
          },
        }),
      }),
    }),
  };
  getWorkerDb.mockReset().mockReturnValue({
    select,
    transaction: async (work: (transaction: typeof tx) => Promise<unknown>) => work(tx),
  });
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe('old settings writes during pool conversion', () => {
  it.each([null, 'best_accuracy'] as const)(
    'converts a first pool without blocking a concurrent platform mode change (mode=%s)',
    async mode => {
      await modeDO.setMode(mode);
      webFetch.mockImplementationOnce(async (url, init) => {
        await expect(modeDO.getMode()).resolves.toBe(mode);
        await modeDO.setMode('cost_per_accuracy');
        return convertRequest(url, init);
      });
      const response = await putSettings(requestedPool, mode);
      expect(response.status).toBe(200);
      expect(canonical).toMatchObject({
        legacy_pool: true,
        entries: [{ kind: 'gateway', model: 'requested/model' }],
        mode: mode ?? 'cost_per_accuracy',
      });
      await expect(modeDO.getMode()).resolves.toBe('cost_per_accuracy');
      expect(entries.has('poolMigratedAt')).toBe(true);
      expect(entries.has('conversionPending')).toBe(false);
    }
  );

  it.each(['slug_taken', 'router_cap_reached', 'failed'] as const)(
    'retries a %s snapshot but rejects later mixed edits to the migrated router',
    async failure => {
      const original = { mode: 'best_accuracy', pool: [{ model: 'original/model' }] } as const;
      await modeDO.setSettings({ ...original, pool: [...original.pool] });
      outcome = failure;
      const failed = await putSettings();
      expect(failed.status).toBe(503);
      expect(canonical).toBeNull();
      await expect(modeDO.getSettings()).resolves.toEqual(original);
      outcome = 'created';
      expect((await putSettings([...original.pool], original.mode)).status).toBe(200);
      expect((await putSettings(repairedPool, 'cost_per_accuracy')).status).toBe(409);
      expect(canonical).toMatchObject({
        mode: 'best_accuracy',
        entries: [{ kind: 'gateway', model: 'original/model' }],
      });
      await expect(modeDO.getMode()).resolves.toBe('best_accuracy');
    }
  );

  it('recovers a pending first pool without replacing a newer platform mode', async () => {
    await modeDO.setMode('best_accuracy');
    webFetch.mockRejectedValueOnce(new Error('web unavailable'));
    expect((await putSettings(requestedPool, 'best_accuracy')).status).toBe(503);
    expect((await modeDO.readStoredSettings()).pool).toEqual(requestedPool);
    await modeDO.setMode('cost_per_accuracy');
    const response = await putSettings(requestedPool, 'best_accuracy');
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ configuredMode: 'cost_per_accuracy' });
    expect(canonical).toMatchObject({
      entries: [{ kind: 'gateway', model: 'requested/model' }],
      mode: 'best_accuracy',
    });
    await expect(modeDO.getMode()).resolves.toBe('cost_per_accuracy');
  });

  it('preserves an acknowledged custom edit while recovering an uncertain conversion commit', async () => {
    webFetch.mockImplementationOnce(async (url, init) => {
      await convertRequest(url, init);
      throw new Error('response lost after commit');
    });
    expect((await putSettings(requestedPool, 'best_accuracy')).status).toBe(503);
    if (!canonical) throw new Error('Expected the uncertain conversion to have committed');
    canonical = {
      ...canonical,
      entries: [{ kind: 'gateway', model: 'repaired/model' }],
      default_entry_key: 'gateway:repaired/model',
      mode: 'cost_per_accuracy',
    };
    expect((await putSettings(repairedPool, 'best_accuracy')).status).toBe(409);
    await expect(
      migrateOwnerPoolForSettings(env as unknown as Env, owner, {
        mode: 'best_accuracy',
        pool: requestedPool,
      })
    ).resolves.toBe('exists');
    expect(canonical).toMatchObject({
      entries: [{ kind: 'gateway', model: 'repaired/model' }],
      mode: 'cost_per_accuracy',
    });
    expect(entries.has('conversionPending')).toBe(false);
    await expect(modeDO.getMode()).resolves.toBe('best_accuracy');
  });

  it('reports a lookup failure without acknowledging or creating a pool', async () => {
    getWorkerDb.mockImplementationOnce(() => {
      throw new Error('database unavailable');
    });
    const response = await putSettings();
    expect(response.status).toBe(503);
    expect(canonical).toBeNull();
    expect(entries.has('conversionPending')).toBe(false);
    expect((await putSettings()).status).toBe(200);
  });

  it('recovers a failed marker without rewriting the canonical pool', async () => {
    vi.spyOn(modeDO, 'markConverted').mockRejectedValueOnce(new Error('storage unavailable'));
    expect((await putSettings()).status).toBe(503);
    expect((await putSettings(repairedPool, 'best_accuracy')).status).toBe(409);
    await expect(
      migrateOwnerPoolForSettings(env as unknown as Env, owner, {
        mode: null,
        pool: requestedPool,
      })
    ).resolves.toBe('exists');
    expect(canonical).toMatchObject({ entries: [{ kind: 'gateway', model: 'requested/model' }] });
    expect(entries.has('conversionPending')).toBe(false);
  });

  it('does not acknowledge a different pool while a delayed scan converts its frozen snapshot', async () => {
    await modeDO.setSettings({ mode: 'best_accuracy', pool: [{ model: 'original/model' }] });
    const snapshot = await modeDO.beginConversion();
    expect((await putSettings(repairedPool, 'cost_per_accuracy')).status).toBe(409);
    const result = await postOwnerPoolConversions(env as unknown as Env, [
      {
        owner: { type: 'user', id: owner.ownerId },
        mode: 'best_accuracy',
        configuredMode: 'best_accuracy',
        models: snapshot.pool?.map(entry => entry.model) ?? [],
      },
    ]);
    expect(result?.[0]?.outcome).toBe('exists');
    expect(canonical).toMatchObject({
      mode: 'best_accuracy',
      entries: [{ kind: 'gateway', model: 'original/model' }],
    });
    await modeDO.setMode('cost_per_accuracy');
    await expect(modeDO.getMode()).resolves.toBe('cost_per_accuracy');
    expect(canonical?.mode).toBe('best_accuracy');
  });

  it('keeps ordinary mode-only settings without creating a custom router', async () => {
    const response = await app.request(
      'https://worker.example.test/settings',
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...owner, mode: 'best_accuracy', pool: null }),
      },
      env
    );
    expect(response.status).toBe(200);
    await expect(modeDO.getMode()).resolves.toBe('best_accuracy');
    expect(canonical).toBeNull();
    expect(entries.has('conversionPending')).toBe(false);
  });
});
