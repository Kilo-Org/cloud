import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearRoutingTableCache, DEFAULT_ROUTING_TABLE, getRoutingTable } from './routing-table';

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
  it('returns the default table when the key is missing and origin has no table', async () => {
    expect(await getRoutingTable(makeEnv(null))).toEqual(DEFAULT_ROUTING_TABLE);
  });

  it('returns the default table when the stored JSON is invalid and origin has no table', async () => {
    expect(await getRoutingTable(makeEnv('{"nope":true}'))).toEqual(DEFAULT_ROUTING_TABLE);
    clearRoutingTableCache();
    expect(await getRoutingTable(makeEnv('not json at all'))).toEqual(DEFAULT_ROUTING_TABLE);
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
          return JSON.stringify(DEFAULT_ROUTING_TABLE);
        },
        put: async () => {},
      },
      BENCHMARK_SERVICE: { fetch: fetchSpy },
      INTERNAL_API_SECRET_PROD: { get: async () => 'secret' },
    } as unknown as KvStub;

    const first = await getRoutingTable(env);
    await getRoutingTable(env);
    expect(first.version).toBe(DEFAULT_ROUTING_TABLE.version);
    expect(reads).toBe(1);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('fetches from origin on KV miss, writes to KV with expirationTtl, and returns the table', async () => {
    const puts: Array<{ key: string; value: string; options: unknown }> = [];
    const env = makeEnv(null, {
      originTable: DEFAULT_ROUTING_TABLE,
      onPut: (key, value, options) => puts.push({ key, value, options }),
    });

    const result = await getRoutingTable(env);
    expect(result).toEqual(DEFAULT_ROUTING_TABLE);
    expect(puts).toHaveLength(1);
    expect(puts[0].key).toBe('routing_table_v1');
    expect(puts[0].options).toEqual({ expirationTtl: 3600 });
  });

  it('returns the default table when origin responds non-OK', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const env = makeEnv(null, { originStatus: 500 });
    expect(await getRoutingTable(env)).toEqual(DEFAULT_ROUTING_TABLE);
    warn.mockRestore();
  });

  it('returns the default table when origin throws', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const env = makeEnv(null, { originThrow: true });
    expect(await getRoutingTable(env)).toEqual(DEFAULT_ROUTING_TABLE);
    warn.mockRestore();
  });

  it('returns the default table when origin returns null table', async () => {
    const env = makeEnv(null, { originTable: undefined });
    expect(await getRoutingTable(env)).toEqual(DEFAULT_ROUTING_TABLE);
  });
});
