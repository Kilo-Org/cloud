import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RoutingTable } from '@kilocode/auto-routing-contracts';
import { clearRoutingTableCache, getRoutingTable } from './routing-table';

const SAMPLE_TABLE: RoutingTable = {
  version: 'bench-run-1',
  generatedAt: '2026-06-12T00:00:00.000Z',
  minAccuracy: 0.7,
  switchCostFactor: 3,
  source: 'benchmark',
  tiers: {
    low: [
      {
        model: 'google/gemini-2.5-flash-lite',
        accuracy: 0.9,
        avgCostUsd: 0.001,
        meetsThreshold: true,
        reasoningEffort: null,
      },
    ],
    medium: [
      {
        model: 'google/gemini-2.5-flash',
        accuracy: 0.85,
        avgCostUsd: 0.002,
        meetsThreshold: true,
        reasoningEffort: null,
      },
    ],
    high: [
      {
        model: 'anthropic/claude-sonnet-4.6',
        accuracy: 0.8,
        avgCostUsd: 0.01,
        meetsThreshold: true,
        reasoningEffort: null,
      },
    ],
  },
};

type KvStub = Pick<Env, 'AUTO_ROUTING_CONFIG' | 'BENCHMARK_SERVICE' | 'INTERNAL_API_SECRET_PROD'>;

function makeEnv(
  kvValue: string | null,
  opts: {
    onGet?: () => void;
    onPut?: (key: string, value: string, options: unknown) => void;
    originTable?: unknown;
    originStatus?: number;
    originThrow?: boolean;
  } = {}
): KvStub {
  return {
    AUTO_ROUTING_CONFIG: {
      get: async () => {
        opts.onGet?.();
        return kvValue;
      },
      put: async (key: string, value: string, options: unknown) => {
        opts.onPut?.(key, value, options);
      },
    },
    BENCHMARK_SERVICE: {
      fetch: async () => {
        if (opts.originThrow) throw new Error('benchmark unavailable');
        return {
          ok: opts.originStatus === undefined ? true : opts.originStatus < 400,
          status: opts.originStatus ?? 200,
          json: async () =>
            opts.originTable !== undefined
              ? { table: opts.originTable, publishedAt: '2026-06-11T00:00:00.000Z' }
              : { table: null, publishedAt: null },
        };
      },
    },
    INTERNAL_API_SECRET_PROD: {
      get: async () => 'test-secret',
    },
  } as unknown as KvStub;
}

afterEach(() => clearRoutingTableCache());

describe('getRoutingTable', () => {
  it('returns null when the key is missing and origin has no table', async () => {
    expect(await getRoutingTable(makeEnv(null))).toBeNull();
  });

  it('returns null when the stored JSON is invalid and origin has no table', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await getRoutingTable(makeEnv('{"nope":true}'))).toBeNull();
    clearRoutingTableCache();
    expect(await getRoutingTable(makeEnv('not json at all'))).toBeNull();
    warn.mockRestore();
  });

  it('parses and caches a valid stored table without calling origin', async () => {
    let reads = 0;
    const fetchSpy = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ table: null, publishedAt: null }),
    }));
    const env: KvStub = {
      AUTO_ROUTING_CONFIG: {
        get: async () => {
          reads++;
          return JSON.stringify(SAMPLE_TABLE);
        },
        put: async () => {},
      },
      BENCHMARK_SERVICE: { fetch: fetchSpy },
      INTERNAL_API_SECRET_PROD: { get: async () => 'secret' },
    } as unknown as KvStub;

    const first = await getRoutingTable(env);
    await getRoutingTable(env);
    expect(first?.version).toBe(SAMPLE_TABLE.version);
    expect(reads).toBe(1);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('fetches from origin on KV miss, writes to KV with expirationTtl, and returns the table', async () => {
    const puts: Array<{ key: string; value: string; options: unknown }> = [];
    const env = makeEnv(null, {
      originTable: SAMPLE_TABLE,
      onPut: (key, value, options) => puts.push({ key, value, options }),
    });

    const result = await getRoutingTable(env);
    expect(result).toEqual(SAMPLE_TABLE);
    expect(puts).toHaveLength(1);
    expect(puts[0].key).toBe('routing_table_v1');
    expect(puts[0].options).toEqual({ expirationTtl: 3600 });
  });

  it('returns null when origin responds non-OK', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const env = makeEnv(null, { originStatus: 500 });
    expect(await getRoutingTable(env)).toBeNull();
    warn.mockRestore();
  });

  it('returns null when origin throws', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const env = makeEnv(null, { originThrow: true });
    expect(await getRoutingTable(env)).toBeNull();
    warn.mockRestore();
  });

  it('returns null when origin returns a null table', async () => {
    const env = makeEnv(null, { originTable: undefined });
    expect(await getRoutingTable(env)).toBeNull();
  });
});
