import { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { RoutingTable } from '@kilocode/auto-routing-contracts';
import { applyBenchmarkMigrations, sqliteD1 } from '../test/sqlite-d1';
import { getLatestRoutingTable, saveRoutingTable } from './db';
import { app } from './index';
import { routingTableResponseKvKey } from './routing-table-response';

function table(version: string): RoutingTable {
  return {
    version,
    generatedAt: '2026-11-19T23:30:00.000Z',
    minAccuracy: 0.7,
    switchCostFactor: 3,
    bestAccuracySwitchThreshold: 0.05,
    source: 'benchmark',
    routes: {
      'implementation/code_generation': [
        { model: 'vendor/model', accuracy: 0.9, avgCostUsd: 0.01, meetsThreshold: true },
      ],
    },
  };
}

describe('GET /admin/routing-table (KV in front of D1)', () => {
  let sqlite: DatabaseSync;
  let db: D1Database;
  let d1Reads: number;
  let store: Map<string, string>;
  let kv: {
    get: Mock<(key: string) => Promise<string | null>>;
    put: Mock<(key: string, value: string, options?: KVNamespacePutOptions) => Promise<void>>;
    delete: Mock<(key: string) => Promise<void>>;
  };
  let env: Env;

  beforeEach(() => {
    sqlite = new DatabaseSync(':memory:');
    applyBenchmarkMigrations(sqlite);
    db = sqliteD1(sqlite);
    d1Reads = 0;
    store = new Map();
    kv = {
      get: vi.fn(async (key: string) => store.get(key) ?? null),
      put: vi.fn(async (key: string, value: string) => {
        store.set(key, value);
      }),
      delete: vi.fn(async (key: string) => {
        store.delete(key);
      }),
    };
    env = {
      BENCH_DB: sqliteD1(sqlite, () => {
        d1Reads++;
      }),
      AUTO_ROUTING_CONFIG: kv,
      INTERNAL_API_SECRET_PROD: { get: async () => 'bench-token' },
    } as unknown as Env;
  });

  afterEach(() => {
    sqlite.close();
    vi.restoreAllMocks();
  });

  function get(path = '/admin/routing-table') {
    return app.request(
      `https://bench.example.com${path}`,
      { headers: { authorization: 'Bearer bench-token' } },
      env
    );
  }

  /** The response the route produced before the cache, from the same D1 rows. */
  async function previousResponse(router: 'efficient' | 'frontier') {
    const reference = new Hono();
    reference.get('/', async c => {
      const latest = await getLatestRoutingTable(db, router);
      return c.json({ table: latest?.table ?? null, publishedAt: latest?.publishedAt ?? null });
    });
    const response = await reference.request('/');
    return { body: await response.text(), contentType: response.headers.get('content-type') };
  }

  it('serves the previous bytes from D1 on a miss and from KV afterwards', async () => {
    await saveRoutingTable(db, table('v1'), '2026-11-19T23:30:42.600Z', 'frontier');
    const expected = await previousResponse('frontier');

    const miss = await get('/admin/routing-table?router=frontier');
    const readsAfterMiss = d1Reads;
    const hit = await get('/admin/routing-table?router=frontier');

    for (const response of [miss, hit]) {
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe(expected.contentType);
    }
    expect(await miss.text()).toBe(expected.body);
    expect(await hit.text()).toBe(expected.body);
    expect(readsAfterMiss).toBeGreaterThan(0);
    expect(d1Reads).toBe(readsAfterMiss);
    expect(kv.put).toHaveBeenCalledExactlyOnceWith(
      routingTableResponseKvKey('frontier'),
      expected.body,
      { expirationTtl: 300 }
    );
  });

  it('caches the empty response per router', async () => {
    const expected = await previousResponse('efficient');

    expect(await (await get()).text()).toBe(expected.body);
    expect(await (await get()).text()).toBe('{"table":null,"publishedAt":null}');
    expect(kv.put).toHaveBeenCalledOnce();
    expect([...store.keys()]).toEqual([routingTableResponseKvKey('efficient')]);
  });

  it('reads the newly published table once publishing deletes the cached response', async () => {
    await saveRoutingTable(db, table('v1'), '2026-11-19T23:00:00.000Z');
    await get();
    await saveRoutingTable(db, table('v2'), '2026-11-19T23:30:00.000Z');
    expect(JSON.parse(await (await get()).text()).table.version).toBe('v1');

    await kv.delete(routingTableResponseKvKey('efficient'));

    expect(await (await get()).text()).toBe((await previousResponse('efficient')).body);
    expect(JSON.parse(store.get(routingTableResponseKvKey('efficient')) ?? '').table.version).toBe(
      'v2'
    );
  });

  it('replaces an unreadable cached value with the D1 response', async () => {
    await saveRoutingTable(db, table('v1'), '2026-11-19T23:00:00.000Z');
    store.set(routingTableResponseKvKey('efficient'), '{"table":');
    const expected = await previousResponse('efficient');

    expect(await (await get()).text()).toBe(expected.body);
    expect(store.get(routingTableResponseKvKey('efficient'))).toBe(expected.body);
  });

  it('serves from D1 when KV is unavailable', async () => {
    await saveRoutingTable(db, table('v1'), '2026-11-19T23:00:00.000Z');
    kv.get.mockRejectedValue(new Error('KV unavailable'));
    kv.put.mockRejectedValue(new Error('KV unavailable'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const expected = await previousResponse('efficient');

    const response = await get();

    expect(response.status).toBe(200);
    expect(await response.text()).toBe(expected.body);
  });
});
