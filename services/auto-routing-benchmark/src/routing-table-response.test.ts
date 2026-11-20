import { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BenchmarkRoutingTableResponseSchema,
  type RoutingTable,
} from '@kilocode/auto-routing-contracts';
import { applyBenchmarkMigrations, sqliteD1 } from '../test/sqlite-d1';
import { getLatestRoutingTable, saveRoutingTable } from './db';
import { app } from './index';
import {
  routingTableResponseKvKey,
  routingTableVersionKvKey,
  syncRoutingTableVersionPointer,
} from './routing-table-response';

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

type StoredValue = { value: string; metadata: unknown; expiresAt: number | null };

describe('GET /admin/routing-table (KV in front of D1)', () => {
  let sqlite: DatabaseSync;
  let db: D1Database;
  let d1Reads: number;
  let store: Map<string, StoredValue>;
  let onBodyRead: () => Promise<void>;
  let onPut: (key: string) => Promise<void>;
  let kvFailure: Error | null;
  let env: Env;

  beforeEach(() => {
    sqlite = new DatabaseSync(':memory:');
    applyBenchmarkMigrations(sqlite);
    db = sqliteD1(sqlite);
    d1Reads = 0;
    store = new Map();
    onBodyRead = async () => {};
    onPut = async () => {};
    kvFailure = null;
    env = {
      BENCH_DB: sqliteD1(sqlite, () => {
        d1Reads++;
      }),
      AUTO_ROUTING_CONFIG: {
        async get(key: string, options?: KVNamespaceGetOptions<'text'>) {
          if (kvFailure) throw kvFailure;
          // Workers KV rejects a cacheTtl below its minimum, 30 s since January 2026.
          if (options?.cacheTtl !== undefined && options.cacheTtl < 30) {
            throw new Error(`Invalid cacheTtl of ${options.cacheTtl}.`);
          }
          return live(key)?.value ?? null;
        },
        async getWithMetadata(key: string) {
          if (kvFailure) throw kvFailure;
          const stored = live(key);
          await onBodyRead();
          return { value: stored?.value ?? null, metadata: stored?.metadata ?? null };
        },
        async put(key: string, value: string, options?: KVNamespacePutOptions) {
          if (kvFailure) throw kvFailure;
          // Workers KV rejects an expirationTtl below its minimum, 60 s.
          if (options?.expirationTtl !== undefined && options.expirationTtl < 60) {
            throw new Error(`Invalid expirationTtl of ${options.expirationTtl}.`);
          }
          await onPut(key);
          store.set(key, {
            value,
            metadata: options?.metadata ?? null,
            expiresAt:
              options?.expirationTtl === undefined
                ? null
                : Date.now() + options.expirationTtl * 1000,
          });
        },
        async delete(key: string) {
          if (kvFailure) throw kvFailure;
          store.delete(key);
        },
      },
      INTERNAL_API_SECRET_PROD: { get: async () => 'bench-token' },
    } as unknown as Env;
  });

  afterEach(() => {
    sqlite.close();
    vi.restoreAllMocks();
  });

  function live(key: string): StoredValue | null {
    const stored = store.get(key);
    if (!stored) return null;
    if (stored.expiresAt !== null && stored.expiresAt <= Date.now()) {
      store.delete(key);
      return null;
    }
    return stored;
  }

  function get() {
    return app.request(
      'https://bench.example.com/admin/routing-table',
      { headers: { authorization: 'Bearer bench-token' } },
      env
    );
  }

  async function publish(version: string, publishedAt: string) {
    await saveRoutingTable(db, table(version), publishedAt);
    await syncRoutingTableVersionPointer(env, 'efficient');
  }

  /** The response the route produced before the cache, from the same D1 rows. */
  async function previousResponse() {
    const reference = new Hono();
    reference.get('/', async c => {
      const latest = await getLatestRoutingTable(db, 'efficient');
      return c.json({ table: latest?.table ?? null, publishedAt: latest?.publishedAt ?? null });
    });
    const response = await reference.request('/');
    return { body: await response.text(), contentType: response.headers.get('content-type') };
  }

  const servedVersion = async () =>
    BenchmarkRoutingTableResponseSchema.parse(JSON.parse(await (await get()).text())).table
      ?.version;

  it('serves the previous bytes from D1 on a miss and from KV afterwards', async () => {
    await publish('v1', '2026-11-19T23:00:00.000Z');
    const expected = await previousResponse();

    const miss = await get();
    const readsAfterMiss = d1Reads;
    const hit = await get();

    for (const response of [miss, hit]) {
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe(expected.contentType);
    }
    expect(await miss.text()).toBe(expected.body);
    expect(await hit.text()).toBe(expected.body);
    expect(readsAfterMiss).toBeGreaterThan(0);
    expect(d1Reads).toBe(readsAfterMiss);
    expect(store.get(routingTableResponseKvKey('efficient'))).toEqual({
      value: expected.body,
      metadata: { token: 'v1 2026-11-19T23:00:00.000Z' },
      expiresAt: expect.any(Number),
    });
  });

  it('seeds a missing pointer from D1 and caches the body', async () => {
    await saveRoutingTable(db, table('v1'), '2026-11-19T23:00:00.000Z');
    const expected = await previousResponse();

    expect(await (await get()).text()).toBe(expected.body);
    const readsAfterSeed = d1Reads;
    expect(await (await get()).text()).toBe(expected.body);

    expect(d1Reads).toBe(readsAfterSeed);
    expect(store.get(routingTableVersionKvKey('efficient'))?.value).toBe(
      'v1 2026-11-19T23:00:00.000Z'
    );
  });

  it('leaves no pointer and caches nothing while no table is published', async () => {
    store.set(routingTableVersionKvKey('efficient'), {
      value: 'gone 2026',
      metadata: null,
      expiresAt: null,
    });

    expect(await (await get()).text()).toBe('{"table":null,"publishedAt":null}');

    expect(store.size).toBe(0);
  });

  it('corrects a seed written after a publish that raced it', async () => {
    await saveRoutingTable(db, table('v1'), '2026-11-19T23:00:00.000Z');
    onPut = async key => {
      if (key !== routingTableVersionKvKey('efficient')) return;
      onPut = async () => {};
      await publish('v2', '2026-11-19T23:30:00.000Z');
    };

    expect(await servedVersion()).toBe('v1');

    expect(store.get(routingTableVersionKvKey('efficient'))?.value).toBe(
      'v2 2026-11-19T23:30:00.000Z'
    );
    expect(store.has(routingTableResponseKvKey('efficient'))).toBe(false);
    expect(await servedVersion()).toBe('v2');
    expect(await servedVersion()).toBe('v2');
  });

  it('serves D1 after a publish that could not move the pointer', async () => {
    await publish('v1', '2026-11-19T23:00:00.000Z');
    expect(await servedVersion()).toBe('v1');
    onPut = async key => {
      if (key !== routingTableVersionKvKey('efficient')) return;
      onPut = async () => {};
      throw new Error('KV 429');
    };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(publish('v2', '2026-11-19T23:30:00.000Z')).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('routing_table_version_pointer_failed')
    );
    expect(store.get(routingTableVersionKvKey('efficient'))?.value).toBe(
      'v1 2026-11-19T23:00:00.000Z'
    );
    expect(store.has(routingTableResponseKvKey('efficient'))).toBe(false);
    expect(await servedVersion()).toBe('v2');
    expect(store.get(routingTableVersionKvKey('efficient'))?.value).toBe(
      'v2 2026-11-19T23:30:00.000Z'
    );
    expect(await servedVersion()).toBe('v2');
  });

  it('repairs the pointer from D1 once a stale body expires', async () => {
    await publish('v1', '2026-11-19T23:00:00.000Z');
    expect(await servedVersion()).toBe('v1');
    // A publish whose pointer write and recovery delete both fail leaves the old pair.
    kvFailure = new Error('KV unavailable');
    await saveRoutingTable(db, table('v2'), '2026-11-19T23:30:00.000Z');
    await syncRoutingTableVersionPointer(env, 'efficient');
    kvFailure = null;
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(store.get(routingTableVersionKvKey('efficient'))?.value).toBe(
      'v1 2026-11-19T23:00:00.000Z'
    );
    expect(store.get(routingTableResponseKvKey('efficient'))?.value).toEqual(
      expect.stringContaining('"version":"v1"')
    );

    expect(await servedVersion()).toBe('v1');
    const stored = store.get(routingTableResponseKvKey('efficient'));
    if (!stored) throw new Error('Expected a cached body');
    expect(stored.expiresAt).toBeGreaterThan(Date.now());
    stored.expiresAt = Date.now() - 1;
    const beforeExpiry = d1Reads;
    const served = await servedVersion();

    expect(served).toBe('v2');
    expect(d1Reads).toBeGreaterThan(beforeExpiry);
    expect(store.get(routingTableVersionKvKey('efficient'))?.value).toBe(
      'v2 2026-11-19T23:30:00.000Z'
    );
    expect(store.get(routingTableResponseKvKey('efficient'))?.metadata).toEqual({
      token: 'v2 2026-11-19T23:30:00.000Z',
    });
  });

  it('serves a newly published table on the next read', async () => {
    await publish('v1', '2026-11-19T23:00:00.000Z');
    expect(await servedVersion()).toBe('v1');

    await publish('v2', '2026-11-19T23:30:00.000Z');

    expect(await servedVersion()).toBe('v2');
    const readsAfterMiss = d1Reads;
    expect(await servedVersion()).toBe('v2');
    expect(d1Reads).toBe(readsAfterMiss);
  });

  it('never serves a body that a read stored after a publish replaced it', async () => {
    await publish('v1', '2026-11-19T23:00:00.000Z');
    onPut = async key => {
      if (key !== routingTableResponseKvKey('efficient')) return;
      onPut = async () => {};
      await publish('v2', '2026-11-19T23:30:00.000Z');
    };

    expect(await servedVersion()).toBe('v1');
    expect(store.get(routingTableResponseKvKey('efficient'))?.metadata).toEqual({
      token: 'v1 2026-11-19T23:00:00.000Z',
    });
    expect(store.get(routingTableVersionKvKey('efficient'))?.value).toBe(
      'v2 2026-11-19T23:30:00.000Z'
    );

    expect(await servedVersion()).toBe('v2');
    expect(await servedVersion()).toBe('v2');
  });

  it('confirms a table published between the pointer read and the D1 read before caching it', async () => {
    await publish('v1', '2026-11-19T23:00:00.000Z');
    onBodyRead = async () => {
      onBodyRead = async () => {};
      await publish('v2', '2026-11-19T23:30:00.000Z');
    };

    expect(await servedVersion()).toBe('v2');
    expect(store.get(routingTableResponseKvKey('efficient'))?.metadata).toEqual({
      token: 'v2 2026-11-19T23:30:00.000Z',
    });
    expect(store.get(routingTableVersionKvKey('efficient'))?.value).toBe(
      'v2 2026-11-19T23:30:00.000Z'
    );
  });

  it('moves a pointer that a concurrent publish overtook to the latest table', async () => {
    await saveRoutingTable(db, table('v1'), '2026-11-19T23:00:00.000Z');
    onPut = async key => {
      if (key !== routingTableVersionKvKey('efficient')) return;
      onPut = async () => {};
      await saveRoutingTable(db, table('v2'), '2026-11-19T23:30:00.000Z');
    };

    await syncRoutingTableVersionPointer(env, 'efficient');

    expect(store.get(routingTableVersionKvKey('efficient'))?.value).toBe(
      'v2 2026-11-19T23:30:00.000Z'
    );
    expect(await servedVersion()).toBe('v2');
  });

  it('serves from D1 when KV is unavailable', async () => {
    await publish('v1', '2026-11-19T23:00:00.000Z');
    kvFailure = new Error('KV unavailable');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const expected = await previousResponse();

    const response = await get();

    expect(response.status).toBe(200);
    expect(await response.text()).toBe(expected.body);
  });
});
