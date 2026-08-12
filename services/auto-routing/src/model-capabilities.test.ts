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

// Stateful KV double: `getWithMetadata` is what writeBack reads to recover
// the union's original expiry, so every double must implement it.
function makeKv(initial?: Record<string, string>): {
  kv: KVNamespace;
  store: Map<string, string>;
  metadata: Map<string, unknown>;
  put: ReturnType<typeof vi.fn>;
} {
  const store = new Map<string, string>(Object.entries(initial ?? {}));
  const metadata = new Map<string, unknown>();
  const put = vi.fn(async (key: string, value: string, options?: KVNamespacePutOptions) => {
    store.set(key, value);
    metadata.set(key, options?.metadata ?? null);
  });
  const kv = {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    getWithMetadata: vi.fn(async (key: string) => ({
      value: store.get(key) ?? null,
      metadata: metadata.get(key) ?? null,
    })),
    put,
  } as unknown as KVNamespace;
  return { kv, store, metadata, put };
}

function makeEnv(kvValue: string | null): Env {
  return {
    AUTO_ROUTING_CONFIG: {
      get: vi.fn(async () => kvValue),
      getWithMetadata: vi.fn(async () => ({ value: kvValue, metadata: null })),
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

    expect(put).toHaveBeenCalledWith('model_capabilities_v2', expect.stringContaining('"a/chat"'), {
      expirationTtl: 3600,
      metadata: { writtenAt: expect.any(Number) },
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
    // The model_capabilities_v2 key is never written; the routing-table
    // lookup on the cache-miss path may write the routing_table_v1 key,
    // and that is unrelated to capability data.
    const capabilityPuts = put.mock.calls.filter(
      (call: unknown[]) => call[0] === 'model_capabilities_v2'
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

  it('supplies static image capabilities for the recognized BytePlus coding-plan default', async () => {
    const env = makeEnv(
      JSON.stringify({
        'a/chat': { inputModalities: ['text'], contextLength: 8192, isActive: true },
        'b/chat': { inputModalities: ['text'], contextLength: 16384, isActive: true },
      })
    );
    const result = await getModelCapabilities(env, {
      codingPlanModelId: 'byteplus-coding/bytedance-seed-code',
    });
    const capabilities = result.get('byteplus-coding/bytedance-seed-code');
    expect(capabilities?.inputModalities.has('image')).toBe(true);
    expect(capabilities?.inputModalities.has('file')).toBe(false);
    expect(capabilities?.contextLength).toBe(262_144);
    expect(capabilities?.isActive).toBe(true);
    expect(dbWhere).not.toHaveBeenCalled();
  });

  it('does not query model_stats for the static BytePlus coding-plan default', async () => {
    dbWhere.mockResolvedValue([
      {
        openrouterId: 'byteplus-coding/bytedance-seed-code',
        inputModalities: ['file'],
        contextLength: 4096,
        isActive: false,
      },
    ]);
    const env = makeEnv(
      JSON.stringify({
        'a/chat': { inputModalities: ['text'], contextLength: 8192, isActive: true },
        'b/chat': { inputModalities: ['text'], contextLength: 16384, isActive: true },
      })
    );
    const result = await getModelCapabilities(env, {
      codingPlanModelId: 'byteplus-coding/bytedance-seed-code',
    });
    const capabilities = result.get('byteplus-coding/bytedance-seed-code');
    expect(capabilities?.inputModalities.has('image')).toBe(true);
    expect(capabilities?.inputModalities.has('file')).toBe(false);
    expect(capabilities?.contextLength).toBe(262_144);
    expect(capabilities?.isActive).toBe(true);
    expect(dbWhere).not.toHaveBeenCalled();
  });

  it('queries an id absent from model_stats once, then serves it from the tombstoned union', async () => {
    // A direct BYOK id has no model_stats row, so the DB answers with nothing.
    dbWhere.mockImplementation(() => Promise.resolve([]));
    const { kv, store } = makeKv({
      model_capabilities_v2: JSON.stringify({
        'a/chat': { inputModalities: ['text'], contextLength: 8192, isActive: true },
        'b/chat': { inputModalities: ['text'], contextLength: 16384, isActive: true },
      }),
    });
    const env = makeEnv(null);
    env.AUTO_ROUTING_CONFIG = kv;

    const first = await getModelCapabilities(env, { additionalModelIds: ['byok/private-model'] });
    expect(first.has('byok/private-model')).toBe(false);
    expect(dbWhere).toHaveBeenCalledTimes(1);

    // The union now records the id as resolved-and-absent, so a later isolate
    // must not pay another Postgres round trip for it.
    expect(JSON.parse(store.get('model_capabilities_v2') as string)).toMatchObject({
      'byok/private-model': { absent: true },
    });

    clearModelCapabilitiesCache();
    const second = await getModelCapabilities(env, { additionalModelIds: ['byok/private-model'] });
    expect(second.has('byok/private-model')).toBe(false);
    expect(dbWhere).toHaveBeenCalledTimes(1);
  });

  it('writes a pool id back to the shared union so other users read it from KV', async () => {
    dbWhere.mockImplementation(() =>
      Promise.resolve([
        { openrouterId: 'pool/vision', inputModalities: ['image'], contextLength: 65536 },
      ])
    );
    const { kv } = makeKv({
      model_capabilities_v2: JSON.stringify({
        'a/chat': { inputModalities: ['text'], contextLength: 8192, isActive: true },
        'b/chat': { inputModalities: ['text'], contextLength: 16384, isActive: true },
      }),
    });
    const env = makeEnv(null);
    env.AUTO_ROUTING_CONFIG = kv;

    // First user configures the pool; the id is resolved from Postgres.
    const first = await getModelCapabilities(env, { additionalModelIds: ['pool/vision'] });
    expect(first.get('pool/vision')?.inputModalities.has('image')).toBe(true);

    // A different user with the same model in their pool reads it from KV.
    clearModelCapabilitiesCache();
    const second = await getModelCapabilities(env, { additionalModelIds: ['pool/vision'] });
    expect(second.get('pool/vision')?.contextLength).toBe(65536);
    expect(dbWhere).toHaveBeenCalledTimes(1);
    // The pre-existing union entries survive the write-back.
    expect(second.get('a/chat')?.contextLength).toBe(8192);
  });

  it('hands the write-back to waitUntil when the caller supplies an execution context', async () => {
    dbWhere.mockImplementation(() =>
      Promise.resolve([
        { openrouterId: 'pool/vision', inputModalities: ['image'], contextLength: 65536 },
      ])
    );
    const { kv, put } = makeKv({
      model_capabilities_v2: JSON.stringify({
        'a/chat': { inputModalities: ['text'], contextLength: 8192 },
      }),
    });
    const env = makeEnv(null);
    env.AUTO_ROUTING_CONFIG = kv;
    const pending: Promise<unknown>[] = [];

    await getModelCapabilities(env, {
      additionalModelIds: ['pool/vision'],
      waitUntil: promise => pending.push(promise),
    });

    expect(pending).toHaveLength(1);
    await Promise.all(pending);
    expect(put).toHaveBeenCalledWith(
      'model_capabilities_v2',
      expect.stringContaining('"pool/vision"'),
      { expirationTtl: expect.any(Number), metadata: { writtenAt: expect.any(Number) } }
    );
  });

  it('holds the original expiry on write-back instead of restarting the TTL', async () => {
    vi.useFakeTimers();
    try {
      const writtenAt = new Date('2026-08-12T00:00:00.000Z').getTime();
      vi.setSystemTime(writtenAt);
      const { kv, put, metadata } = makeKv({
        model_capabilities_v2: JSON.stringify({
          'a/chat': { inputModalities: ['text'], contextLength: 8192 },
        }),
      });
      metadata.set('model_capabilities_v2', { writtenAt });
      const env = makeEnv(null);
      env.AUTO_ROUTING_CONFIG = kv;
      dbWhere.mockImplementation(() =>
        Promise.resolve([
          { openrouterId: 'pool/vision', inputModalities: ['image'], contextLength: 65536 },
        ])
      );

      // Half an hour into the union's 1-hour life.
      vi.setSystemTime(writtenAt + 1_800_000);
      await getModelCapabilities(env, { additionalModelIds: ['pool/vision'] });

      const options = put.mock.calls.at(-1)?.[2] as KVNamespacePutOptions;
      // Roughly the remaining half hour, NOT a fresh 3600.
      expect(options.expirationTtl).toBe(1800);
      // The original stamp is carried forward, so the next fill shrinks again.
      expect(options.metadata).toEqual({ writtenAt });
    } finally {
      vi.useRealTimers();
    }
  });

  it('skips the write-back when the union is about to expire', async () => {
    vi.useFakeTimers();
    try {
      const writtenAt = new Date('2026-08-12T00:00:00.000Z').getTime();
      vi.setSystemTime(writtenAt);
      const { kv, put, metadata } = makeKv({
        model_capabilities_v2: JSON.stringify({
          'a/chat': { inputModalities: ['text'], contextLength: 8192 },
        }),
      });
      metadata.set('model_capabilities_v2', { writtenAt });
      const env = makeEnv(null);
      env.AUTO_ROUTING_CONFIG = kv;
      dbWhere.mockImplementation(() =>
        Promise.resolve([
          { openrouterId: 'pool/vision', inputModalities: ['image'], contextLength: 65536 },
        ])
      );

      // 10s of life left: under the 60s KV minimum, so no write is attempted.
      vi.setSystemTime(writtenAt + 3_590_000);
      const result = await getModelCapabilities(env, { additionalModelIds: ['pool/vision'] });

      // The caller still gets the freshly queried row.
      expect(result.get('pool/vision')?.contextLength).toBe(65536);
      const capabilityPuts = put.mock.calls.filter(call => call[0] === 'model_capabilities_v2');
      expect(capabilityPuts).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('treats a tombstoned id as unknown capability data, not as an empty capability set', async () => {
    const env = makeEnv(
      JSON.stringify({
        'a/chat': { inputModalities: ['text'], contextLength: 8192, isActive: true },
        'b/chat': { inputModalities: ['text'], contextLength: 16384, isActive: true },
        'byok/private-model': {
          inputModalities: [],
          contextLength: null,
          isActive: null,
          absent: true,
        },
      })
    );
    const result = await getModelCapabilities(env, {
      additionalModelIds: ['byok/private-model'],
    });
    // Absent from the map, so satisfiesRequiredModalities fails it closed and
    // contextProvablyTooSmall leaves its rank alone.
    expect(result.has('byok/private-model')).toBe(false);
    expect(dbWhere).not.toHaveBeenCalled();
  });

  it('does not synthesize capabilities when BytePlus is not the coding-plan model', async () => {
    const env = makeEnv(
      JSON.stringify({
        'a/chat': { inputModalities: ['text'], contextLength: 8192, isActive: true },
        'b/chat': { inputModalities: ['text'], contextLength: 16384, isActive: true },
      })
    );
    const result = await getModelCapabilities(env, {
      additionalModelIds: ['byteplus-coding/bytedance-seed-code'],
    });
    expect(result.has('byteplus-coding/bytedance-seed-code')).toBe(false);
  });

  it('distinguishes an unavailable routing table from a genuinely empty one when caching capabilities', async () => {
    const put = vi.fn(async () => undefined);
    const get = vi.fn(async () => null);
    const getWithMetadata = vi.fn(async () => ({ value: null, metadata: null }));
    const env = makeEnv(null);
    env.AUTO_ROUTING_CONFIG = { get, getWithMetadata, put } as unknown as KVNamespace;

    // (a) Routing table is unavailable: queryAllIds returns null, so the origin
    // value for kvReadThrough is null and the model_capabilities_v2 key is NOT
    // written. A later in-memory-miss must still re-check KV and re-fetch origin.
    mockGetRoutingTable.mockResolvedValue(null);
    const first = await getModelCapabilities(env, { codingPlanModelId: 'coding-plan/chat' });
    expect(first.size).toBe(0);
    const capabilityPutsBefore = put.mock.calls.filter(
      (call: unknown[]) => call[0] === 'model_capabilities_v2'
    );
    expect(capabilityPutsBefore).toEqual([]);

    clearModelCapabilitiesCache();
    const second = await getModelCapabilities(env, { codingPlanModelId: 'coding-plan/chat' });
    expect(second.size).toBe(0);
    expect(get).toHaveBeenCalledTimes(2);
    const capabilityPutsAfter = put.mock.calls.filter(
      (call: unknown[]) => call[0] === 'model_capabilities_v2'
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
      call => call[0] === 'model_capabilities_v2'
    );
    // Two writes: the empty union from the read-through, then the partial
    // fill recording that the coding-plan id has no model_stats row.
    expect(capabilityPutsEmpty).toHaveLength(2);
    expect(JSON.parse(capabilityPutsEmpty[0][1] as unknown as string)).toEqual({});
    expect(JSON.parse(capabilityPutsEmpty[1][1] as unknown as string)).toMatchObject({
      'coding-plan/chat': { absent: true },
    });
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

  it('selects isActive from model_stats and normalizes absent KV isActive to null', async () => {
    dbWhere.mockImplementation(() =>
      Promise.resolve([
        {
          openrouterId: 'a/chat',
          inputModalities: ['text'],
          contextLength: 8192,
          isActive: true,
        },
        {
          openrouterId: 'b/chat',
          inputModalities: ['text'],
          contextLength: 4096,
          isActive: false,
        },
      ])
    );
    const env = makeEnv(null);
    const result = await getModelCapabilities(env);
    expect(result.get('a/chat')?.isActive).toBe(true);
    expect(result.get('b/chat')?.isActive).toBe(false);

    clearModelCapabilitiesCache();
    const envFromKv = makeEnv(
      JSON.stringify({
        'a/chat': { inputModalities: ['text'], contextLength: 8192 },
        'b/chat': { inputModalities: ['text'], contextLength: 4096, isActive: null },
      })
    );
    const fromKv = await getModelCapabilities(envFromKv);
    expect(fromKv.get('a/chat')?.isActive).toBeNull();
    expect(fromKv.get('b/chat')?.isActive).toBeNull();
  });

  it('unions additionalModelIds into the queried id set', async () => {
    dbWhere.mockImplementation(() =>
      Promise.resolve([
        { openrouterId: 'a/chat', inputModalities: ['text'], contextLength: 8192, isActive: true },
        {
          openrouterId: 'pool/extra',
          inputModalities: ['text'],
          contextLength: 4096,
          isActive: true,
        },
      ])
    );
    const env = makeEnv(null);
    const result = await getModelCapabilities(env, {
      additionalModelIds: ['pool/extra', 'a/chat'],
    });
    expect(result.get('pool/extra')?.contextLength).toBe(4096);
    expect(result.get('a/chat')?.isActive).toBe(true);
  });
});
