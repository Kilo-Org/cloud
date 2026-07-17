import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearModelCapabilitiesCache, getModelCapabilities } from './model-capabilities';
import { clearRoutingTableCache } from './routing-table';
import type * as RoutingTableModule from './routing-table';
import type * as DbModule from '@kilocode/db';
import type { RoutingTable } from '@kilocode/auto-routing-contracts';

const getWorkerDb = vi.hoisted(() => vi.fn());
const dbSelect = vi.hoisted(() => vi.fn());
const dbFrom = vi.hoisted(() => vi.fn());
const dbWhere = vi.hoisted(() => vi.fn());
const mockGetRoutingTable = vi.hoisted(() => vi.fn());

vi.mock('@kilocode/db', async importOriginal => {
  const actual = await importOriginal<typeof DbModule>();
  return { ...actual, getWorkerDb };
});

vi.mock('./routing-table', async importOriginal => {
  const actual = await importOriginal<typeof RoutingTableModule>();
  return { ...actual, getRoutingTable: mockGetRoutingTable };
});

const SAMPLE_ROUTING_TABLE: RoutingTable = {
  version: 'bench-1',
  generatedAt: '2026-06-12T00:00:00.000Z',
  minAccuracy: 0.7,
  switchCostFactor: 3,
  bestAccuracySwitchThreshold: 0.05,
  source: 'benchmark',
  routes: {
    'implementation/code_generation': [
      { model: 'a/chat', accuracy: 0.9, avgCostUsd: 0.001, meetsThreshold: true },
      { model: 'b/chat', accuracy: 0.85, avgCostUsd: 0.002, meetsThreshold: true },
    ],
  },
};

function makeEnv(kvValue: string | null): Env {
  return {
    AUTO_ROUTING_CONFIG: {
      get: vi.fn(async () => kvValue),
      put: vi.fn(async () => undefined),
    } as unknown as KVNamespace,
    HYPERDRIVE: { connectionString: 'postgres://worker' } as Hyperdrive,
    BENCHMARK_SERVICE: {
      fetch: vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          table: SAMPLE_ROUTING_TABLE,
          publishedAt: SAMPLE_ROUTING_TABLE.generatedAt,
        }),
      })),
    } as unknown as Fetcher,
    INTERNAL_API_SECRET_PROD: { get: async () => 'secret' } as unknown as SecretsStoreSecret,
  } as unknown as Env;
}

afterEach(() => {
  clearModelCapabilitiesCache();
  clearRoutingTableCache();
});

beforeEach(() => {
  getWorkerDb.mockReset();
  getWorkerDb.mockReturnValue({ select: dbSelect });
  dbSelect.mockReset();
  dbSelect.mockReturnValue({ from: dbFrom });
  dbFrom.mockReset();
  dbFrom.mockReturnValue({ where: dbWhere });
  dbWhere.mockReset();
  dbWhere.mockImplementation(() => Promise.resolve([]));
  mockGetRoutingTable.mockReset();
  mockGetRoutingTable.mockResolvedValue(SAMPLE_ROUTING_TABLE);
});

describe('getModelCapabilities', () => {
  it('folds image_url to image in the capability set', async () => {
    dbWhere.mockImplementation(() =>
      Promise.resolve([
        { openrouterId: 'a/chat', inputModalities: ['image_url'], contextLength: 8192 },
      ])
    );
    const env = makeEnv(null);
    const result = await getModelCapabilities(env);
    expect(result.get('a/chat')?.inputModalities.has('image')).toBe(true);
    expect(result.get('a/chat')?.inputModalities.has('image_url')).toBe(false);
    expect(result.get('a/chat')?.contextLength).toBe(8192);
  });

  it('folds confirmed real input modalities to their canonical forms', async () => {
    dbWhere.mockImplementation(() =>
      Promise.resolve([
        { openrouterId: 'doc/chat', inputModalities: ['image_url', 'file'], contextLength: 32768 },
      ])
    );
    const env = makeEnv(null);
    const result = await getModelCapabilities(env);
    const set = result.get('doc/chat')?.inputModalities;
    expect(set?.has('image')).toBe(true); // image_url folded to canonical image
    expect(set?.has('file')).toBe(true); // file is a real input modality
    expect(set?.has('image_url')).toBe(false);
  });

  it('treats null input_modalities as an empty modality set, not a failure', async () => {
    dbWhere.mockImplementation(() =>
      Promise.resolve([{ openrouterId: 'a/chat', inputModalities: null, contextLength: 4096 }])
    );
    const env = makeEnv(null);
    const result = await getModelCapabilities(env);
    expect(result.get('a/chat')?.inputModalities.size).toBe(0);
    expect(result.get('a/chat')?.contextLength).toBe(4096);
  });

  it('caches results in KV and avoids a second DB read on subsequent calls', async () => {
    dbWhere.mockImplementation(() =>
      Promise.resolve([
        { openrouterId: 'a/chat', inputModalities: ['image'], contextLength: 8192 },
        { openrouterId: 'b/chat', inputModalities: ['text'], contextLength: 16384 },
      ])
    );
    const env = makeEnv(null);
    const first = await getModelCapabilities(env);
    const second = await getModelCapabilities(env);
    expect(first.get('a/chat')?.inputModalities.has('image')).toBe(true);
    expect(second.get('a/chat')?.inputModalities.has('image')).toBe(true);
    // The DB is only hit on the first call; the second call satisfies from
    // the in-memory cache (no DB read, no KV read).
    expect(dbWhere).toHaveBeenCalledTimes(1);
  });

  it('reads from KV on in-memory miss and avoids the DB', async () => {
    const cached = {
      'a/chat': { inputModalities: ['image'], contextLength: 8192 },
      'b/chat': { inputModalities: ['text'], contextLength: 16384 },
    };
    const env = makeEnv(JSON.stringify(cached));
    const result = await getModelCapabilities(env);
    expect(result.get('a/chat')?.inputModalities.has('image')).toBe(true);
    expect(result.get('b/chat')?.contextLength).toBe(16384);
    expect(dbWhere).not.toHaveBeenCalled();
  });

  it('writes the queried rows to KV on a true miss with the configured expirationTtl', async () => {
    const put = vi.fn(async () => undefined);
    const env = {
      AUTO_ROUTING_CONFIG: {
        get: vi.fn(async () => null),
        put,
      } as unknown as KVNamespace,
      HYPERDRIVE: { connectionString: 'postgres://worker' } as Hyperdrive,
      BENCHMARK_SERVICE: {
        fetch: vi.fn(async () => ({
          ok: true,
          status: 200,
          json: async () => ({
            table: SAMPLE_ROUTING_TABLE,
            publishedAt: SAMPLE_ROUTING_TABLE.generatedAt,
          }),
        })),
      } as unknown as Fetcher,
      INTERNAL_API_SECRET_PROD: { get: async () => 'secret' } as unknown as SecretsStoreSecret,
    } as unknown as Env;
    dbWhere.mockImplementation(() =>
      Promise.resolve([{ openrouterId: 'a/chat', inputModalities: ['image'], contextLength: 8192 }])
    );

    await getModelCapabilities(env);

    expect(put).toHaveBeenCalledWith('model_capabilities_v1', expect.stringContaining('"a/chat"'), {
      expirationTtl: 3600,
    });
  });

  it('returns an empty map and does NOT write to KV when the DB throws', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const put = vi.fn(async () => undefined);
    const env = {
      AUTO_ROUTING_CONFIG: {
        get: vi.fn(async () => null),
        put,
      } as unknown as KVNamespace,
      HYPERDRIVE: { connectionString: 'postgres://worker' } as Hyperdrive,
      BENCHMARK_SERVICE: {
        fetch: vi.fn(async () => ({
          ok: true,
          status: 200,
          json: async () => ({
            table: SAMPLE_ROUTING_TABLE,
            publishedAt: SAMPLE_ROUTING_TABLE.generatedAt,
          }),
        })),
      } as unknown as Fetcher,
      INTERNAL_API_SECRET_PROD: { get: async () => 'secret' } as unknown as SecretsStoreSecret,
    } as unknown as Env;
    dbWhere.mockImplementation(() => Promise.reject(new Error('db down')));

    const result = await getModelCapabilities(env);
    expect(result.size).toBe(0);
    // The model_capabilities_v1 key is never written; the routing-table
    // lookup on the cache-miss path may write the routing_table_v1 key,
    // and that is unrelated to capability data.
    const capabilityPuts = put.mock.calls.filter(
      (call: unknown[]) => call[0] === 'model_capabilities_v1'
    );
    expect(capabilityPuts).toEqual([]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('returns an empty map promptly when the underlying load exceeds the sub-budget (named timing test)', async () => {
    vi.useFakeTimers();
    try {
      // Simulate a slow Hyperdrive: the DB promise never resolves in real
      // time, so the 500ms sub-budget must trip first.
      dbWhere.mockImplementation(() => new Promise(() => {}) as unknown as Promise<unknown>);
      const env = makeEnv(null);

      const resultP = getModelCapabilities(env);
      // Advance the fake clock past the 500ms budget; the budget timer
      // fires and rejects, which the wrapper converts to an empty Map.
      await vi.advanceTimersByTimeAsync(600);
      const result = await resultP;
      expect(result.size).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('attaches a no-op swallow to the slow promise so no unhandled rejection escapes', async () => {
    vi.useFakeTimers();
    const captured: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      captured.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      let rejectDb: (err: unknown) => void = () => {};
      dbWhere.mockImplementation(
        () =>
          new Promise((_, reject) => {
            rejectDb = reject;
          }) as unknown as Promise<unknown>
      );
      const env = makeEnv(null);

      const resultP = getModelCapabilities(env);
      await vi.advanceTimersByTimeAsync(600);
      const result = await resultP;
      expect(result.size).toBe(0);

      // Now reject the original DB promise; without a no-op catch it would
      // surface as an unhandledRejection.
      rejectDb(new Error('db failed after budget fired'));
      // Let the rejection propagate; a tick is enough.
      await Promise.resolve();
      await Promise.resolve();
      expect(captured).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
      vi.useRealTimers();
    }
  });

  it('returns an empty map promptly when the routing table fetch exceeds the sub-budget', async () => {
    vi.useFakeTimers();
    try {
      mockGetRoutingTable.mockImplementation(
        () => new Promise(() => {}) as Promise<RoutingTable | null>
      );
      const env = makeEnv(null);

      const resultP = getModelCapabilities(env);
      await vi.advanceTimersByTimeAsync(600);
      const result = await resultP;
      expect(result.size).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not leak an unhandled rejection when the routing table fetch rejects after the budget', async () => {
    vi.useFakeTimers();
    const captured: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      captured.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      let rejectRoutingTable: (err: unknown) => void = () => {};
      mockGetRoutingTable.mockImplementation(
        () =>
          new Promise((_, reject) => {
            rejectRoutingTable = reject;
          }) as Promise<RoutingTable | null>
      );
      const env = makeEnv(null);

      const resultP = getModelCapabilities(env);
      await vi.advanceTimersByTimeAsync(600);
      const result = await resultP;
      expect(result.size).toBe(0);

      // Now reject the original routing-table promise; without a no-op catch
      // it would surface as an unhandledRejection.
      rejectRoutingTable(new Error('routing table failed after budget fired'));
      await Promise.resolve();
      await Promise.resolve();
      expect(captured).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
      vi.useRealTimers();
    }
  });

  it('includes the coding-plan model id in the queried id set', async () => {
    dbWhere.mockImplementation((..._args: unknown[]) => {
      // First call is the in-cache-miss DB query (full id set), which will
      // not happen because we are testing the partial-fill path. We still
      // answer the partial-fill query for the coding-plan id.
      return Promise.resolve([
        { openrouterId: 'coding-plan/chat', inputModalities: ['text'], contextLength: 200000 },
      ]);
    });
    const env = makeEnv(
      JSON.stringify({
        'a/chat': { inputModalities: ['image'], contextLength: 8192 },
        'b/chat': { inputModalities: ['text'], contextLength: 16384 },
      })
    );
    const result = await getModelCapabilities(env, { codingPlanModelId: 'coding-plan/chat' });
    expect(result.get('coding-plan/chat')?.contextLength).toBe(200000);
  });

  it('distinguishes an unavailable routing table from a genuinely empty one when caching capabilities', async () => {
    const put = vi.fn(async () => undefined);
    const get = vi.fn(async () => null);
    const env = makeEnv(null);
    env.AUTO_ROUTING_CONFIG = { get, put } as unknown as KVNamespace;

    // (a) Routing table is unavailable: queryAllIds returns null, so the origin
    // value for kvReadThrough is null and the model_capabilities_v1 key is NOT
    // written. A later in-memory-miss must still re-check KV and re-fetch origin.
    mockGetRoutingTable.mockResolvedValue(null);
    const first = await getModelCapabilities(env, { codingPlanModelId: 'coding-plan/chat' });
    expect(first.size).toBe(0);
    const capabilityPutsBefore = put.mock.calls.filter(
      (call: unknown[]) => call[0] === 'model_capabilities_v1'
    );
    expect(capabilityPutsBefore).toEqual([]);

    clearModelCapabilitiesCache();
    const second = await getModelCapabilities(env, { codingPlanModelId: 'coding-plan/chat' });
    expect(second.size).toBe(0);
    expect(get).toHaveBeenCalledTimes(2);
    const capabilityPutsAfter = put.mock.calls.filter(
      (call: unknown[]) => call[0] === 'model_capabilities_v1'
    );
    expect(capabilityPutsAfter).toEqual([]);

    // (b) Routing table resolves successfully but has zero candidates: this is
    // real data, not a failure, so the empty map IS written to KV.
    put.mockClear();
    get.mockClear();
    clearModelCapabilitiesCache();
    clearRoutingTableCache();
    mockGetRoutingTable.mockResolvedValue({
      ...SAMPLE_ROUTING_TABLE,
      routes: {},
    });
    const third = await getModelCapabilities(env, { codingPlanModelId: 'coding-plan/chat' });
    expect(third.size).toBe(0);
    const capabilityPutsEmpty = (put.mock.calls as unknown[][]).filter(
      call => call[0] === 'model_capabilities_v1'
    );
    expect(capabilityPutsEmpty).toHaveLength(1);
    expect(JSON.parse(capabilityPutsEmpty[0][1] as unknown as string)).toEqual({});
  });

  it('returns an empty map when the routing table is missing entirely', async () => {
    mockGetRoutingTable.mockResolvedValue(null);
    const env = {
      AUTO_ROUTING_CONFIG: {
        get: vi.fn(async () => null),
        put: vi.fn(async () => undefined),
      } as unknown as KVNamespace,
      HYPERDRIVE: { connectionString: 'postgres://worker' } as Hyperdrive,
      BENCHMARK_SERVICE: {
        fetch: vi.fn(async () => ({
          ok: true,
          status: 200,
          json: async () => ({ table: null, publishedAt: null }),
        })),
      } as unknown as Fetcher,
      INTERNAL_API_SECRET_PROD: { get: async () => 'secret' } as unknown as SecretsStoreSecret,
    } as unknown as Env;
    dbWhere.mockReset();
    const result = await getModelCapabilities(env);
    expect(result.size).toBe(0);
  });
});
