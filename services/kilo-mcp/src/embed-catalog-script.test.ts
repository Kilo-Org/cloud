import { rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';
import { EMBEDDING_DIMENSIONS, EMBEDDING_METRIC, EMBEDDING_MODEL } from '../src/embedding';
import type { Catalog } from '../src/types';
import {
  CfApiError,
  EMBED_BATCH_SIZE,
  PRUNE_BATCH_SIZE,
  embedAndUpsert,
  ensureIndex,
  loadCatalog,
  parseCatalog,
  loadDeleteCandidates,
  pruneRemovedPaths,
} from '../scripts/embed-catalog.ts';

const ENV = {
  CLOUDFLARE_ACCOUNT_ID: 'acct123',
  CLOUDFLARE_API_TOKEN: 'token-secret',
  VECTORIZE_INDEX_NAME: 'kilo-mcp-catalog-dev',
};

/** A minimal catalog of `count` rows. */
function catalogOf(count: number): Catalog {
  return Object.fromEntries(
    Array.from({ length: count }, (_, i) => [
      `proc${i}.list`,
      {
        path: `proc${i}.list`,
        kind: 'query',
        summary: `Summary ${i}`,
        inputSchema: {},
        tags: [`tag${i}`],
        searchBlob: `proc${i}.list Summary ${i} tag${i}`,
      },
    ])
  );
}

/**
 * One well-formed catalog row with an arbitrary `kind`, for validator tests.
 * Built as a raw record because `parseCatalog` validates unknown JSON before
 * it is narrowed to `Catalog`.
 */
function rowOf(path: string, kind: string): Record<string, unknown> {
  return {
    path,
    kind,
    summary: `Summary ${path}`,
    inputSchema: {},
    tags: [`tag:${path}`],
    searchBlob: `${path} Summary ${path} tag:${path}`,
  };
}

type RecordedCall = {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
};

/** A fetch fake that records calls and answers each route via `routes`. */
function fetchFake(routes: Array<(call: RecordedCall) => unknown | undefined>): {
  fetchImpl: (
    url: string,
    init?: Record<string, unknown>
  ) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const fetchImpl = async (url: string, init?: Record<string, unknown>) => {
    const call: RecordedCall = {
      url,
      method: init?.['method'] as string | undefined,
      headers: init?.['headers'] as Record<string, string> | undefined,
      body: init?.['body'] as string | undefined,
    };
    calls.push(call);
    for (const route of routes) {
      const result = route(call);
      if (result !== undefined) {
        return { ok: true, status: 200, json: async () => ({ success: true, result }) };
      }
    }
    return {
      ok: false,
      status: 404,
      json: async () => ({ success: false, errors: [{ code: 7000, message: 'index not found' }] }),
    };
  };
  return { fetchImpl, calls };
}

/** Narrows a parsed delete_by_ids body so the test reads `ids` without a cast. */
function hasIds(value: unknown): value is { ids: string[] } {
  if (typeof value !== 'object' || value === null || !('ids' in value)) return false;
  const { ids } = value;
  return Array.isArray(ids) && ids.every(id => typeof id === 'string');
}

describe('ensureIndex', () => {
  it('creates the index with the pinned dimensions and metric when it does not exist', async () => {
    const { fetchImpl, calls } = fetchFake([
      call =>
        call.url.endsWith(`/vectorize/v2/indexes/${ENV.VECTORIZE_INDEX_NAME}`) ? null : undefined,
      call => (call.url.endsWith('/vectorize/v2/indexes') ? {} : undefined),
    ]);
    const log = vi.fn();
    const outcome = await ensureIndex({
      ...ENV,
      catalog: {},
      fetchImpl,
      log,
    });
    expect(outcome).toEqual({ created: true, indexName: 'kilo-mcp-catalog-dev' });
    const create = calls.find(call => call.method === 'POST');
    expect(create?.url).toBe(
      `https://api.cloudflare.com/client/v4/accounts/${ENV.CLOUDFLARE_ACCOUNT_ID}/vectorize/v2/indexes`
    );
    expect(JSON.parse(create!.body!)).toEqual({
      name: 'kilo-mcp-catalog-dev',
      config: { dimensions: EMBEDDING_DIMENSIONS, metric: EMBEDDING_METRIC },
      description: expect.any(String),
    });
    expect(log).toHaveBeenCalledWith(expect.stringContaining('created index'));
  });

  it('leaves an existing index untouched (idempotent)', async () => {
    const { fetchImpl, calls } = fetchFake([
      call =>
        call.url.endsWith(`/vectorize/v2/indexes/${ENV.VECTORIZE_INDEX_NAME}`)
          ? { name: ENV.VECTORIZE_INDEX_NAME }
          : undefined,
    ]);
    const outcome = await ensureIndex({ ...ENV, catalog: {}, fetchImpl });
    expect(outcome).toEqual({ created: false, indexName: 'kilo-mcp-catalog-dev' });
    expect(calls.filter(call => call.method === 'POST')).toHaveLength(0);
  });

  it('surfaces API errors with their HTTP status', async () => {
    const fetchImpl = async () => ({
      ok: false,
      status: 403,
      json: async () => ({
        success: false,
        errors: [{ code: 10000, message: 'authentication error' }],
      }),
    });
    await expect(ensureIndex({ ...ENV, catalog: {}, fetchImpl })).rejects.toThrow(CfApiError);
    await expect(ensureIndex({ ...ENV, catalog: {}, fetchImpl })).rejects.toThrow(
      'authentication error'
    );
  });
});

describe('embedAndUpsert', () => {
  it('embeds searchBlobs with the pinned model and upserts vector id = path with {path, kind, tags} metadata', async () => {
    const vector = Array.from({ length: EMBEDDING_DIMENSIONS }, () => 0.5);
    const { fetchImpl, calls } = fetchFake([
      call => (call.url.includes('/ai/run/') ? { data: [vector] } : undefined),
      call => (call.url.includes('/upsert') ? { count: 1, mutationId: 'm1' } : undefined),
    ]);
    const outcome = await embedAndUpsert({ ...ENV, catalog: catalogOf(1), fetchImpl });
    expect(outcome).toEqual({ vectors: 1 });

    const embed = calls.find(call => call.url.includes('/ai/run/'))!;
    expect(embed.url).toBe(
      `https://api.cloudflare.com/client/v4/accounts/${ENV.CLOUDFLARE_ACCOUNT_ID}/ai/run/${EMBEDDING_MODEL}`
    );
    expect(JSON.parse(embed.body!)).toEqual({ text: ['proc0.list Summary 0 tag0'] });

    const upsert = calls.find(call => call.url.includes('/upsert'))!;
    expect(upsert.headers?.['Content-Type']).toBe('application/x-ndjson');
    const record = JSON.parse(upsert.body!.split('\n')[0]!);
    expect(record.id).toBe('proc0.list');
    expect(record.values).toEqual(vector);
    expect(record.metadata).toEqual({ path: 'proc0.list', kind: 'query', tags: ['tag0'] });
  });

  it('batches at most 64 rows per embed and upsert request', async () => {
    const vector = Array.from({ length: EMBEDDING_DIMENSIONS }, () => 0.25);
    const count = EMBED_BATCH_SIZE * 2 + 5;
    const { fetchImpl, calls } = fetchFake([
      call => {
        if (!call.url.includes('/ai/run/')) return undefined;
        const requested = (JSON.parse(call.body!) as { text: string[] }).text.length;
        return { data: Array.from({ length: requested }, () => vector) };
      },
      call => (call.url.includes('/upsert') ? { count: call.body!.split('\n').length } : undefined),
    ]);
    const outcome = await embedAndUpsert({ ...ENV, catalog: catalogOf(count), fetchImpl });
    const embedCalls = calls.filter(call => call.url.includes('/ai/run/'));
    expect(embedCalls).toHaveLength(3);
    const batchSizes = embedCalls.map(
      call => (JSON.parse(call.body!) as { text: string[] }).text.length
    );
    expect(batchSizes).toEqual([EMBED_BATCH_SIZE, EMBED_BATCH_SIZE, 5]);
    expect(outcome.vectors).toBe(count);
  });

  it('indexes a mutation row with kind "mutation" in the vector metadata', async () => {
    const vector = Array.from({ length: EMBEDDING_DIMENSIONS }, () => 0.75);
    const { fetchImpl, calls } = fetchFake([
      call => (call.url.includes('/ai/run/') ? { data: [vector] } : undefined),
      call => (call.url.includes('/upsert') ? { count: 1 } : undefined),
    ]);
    const catalog = parseCatalog({
      'agentProfiles.create': rowOf('agentProfiles.create', 'mutation'),
    });
    await embedAndUpsert({ ...ENV, catalog, fetchImpl });
    const upsert = calls.find(call => call.url.includes('/upsert'))!;
    const record = JSON.parse(upsert.body!.split('\n')[0]!);
    expect(record).toMatchObject({
      id: 'agentProfiles.create',
      metadata: {
        path: 'agentProfiles.create',
        kind: 'mutation',
        tags: ['tag:agentProfiles.create'],
      },
    });
  });

  it('fails loudly when the embedding API returns fewer vectors than rows sent', async () => {
    const { fetchImpl } = fetchFake([
      call => (call.url.includes('/ai/run/') ? { data: [] } : undefined),
    ]);
    await expect(embedAndUpsert({ ...ENV, catalog: catalogOf(2), fetchImpl })).rejects.toThrow(
      'returned 0 vectors for a batch of 2'
    );
  });
});

describe('pruneRemovedPaths', () => {
  const deleteUrl = `https://api.cloudflare.com/client/v4/accounts/${ENV.CLOUDFLARE_ACCOUNT_ID}/vectorize/v2/indexes/${ENV.VECTORIZE_INDEX_NAME}/delete_by_ids`;

  it('deletes every known id the current catalog no longer has', async () => {
    const { fetchImpl, calls } = fetchFake([
      call => (call.url.endsWith('/delete_by_ids') ? { mutationId: 'm1' } : undefined),
    ]);
    // The history names an id from an older release and one from a run whose
    // prune failed: both must go, so a failed run cannot strand a vector.
    const everIndexed = ['proc0.list', 'gone.lastRelease', 'gone.failedRun', 'gone.failedRun'];
    const outcome = await pruneRemovedPaths(
      { ...ENV, catalog: catalogOf(1), fetchImpl },
      everIndexed
    );
    expect(outcome).toEqual({ deleted: ['gone.failedRun', 'gone.lastRelease'] });
    const deletes = calls.filter(call => call.url.endsWith('/delete_by_ids'));
    expect(deletes).toHaveLength(1);
    expect(deletes[0]!.url).toBe(deleteUrl);
    expect(deletes[0]!.method).toBe('POST');
    const body: unknown = JSON.parse(deletes[0]!.body!);
    if (!hasIds(body)) throw new Error('delete body has no ids array');
    expect(body.ids).toEqual(['gone.failedRun', 'gone.lastRelease']);
  });

  it('issues no request when every known id is still in the catalog', async () => {
    const { fetchImpl, calls } = fetchFake([
      call => (call.url.endsWith('/delete_by_ids') ? {} : undefined),
    ]);
    const outcome = await pruneRemovedPaths({ ...ENV, catalog: catalogOf(2), fetchImpl }, [
      'proc0.list',
      'proc1.list',
    ]);
    expect(outcome).toEqual({ deleted: [] });
    expect(calls).toHaveLength(0);
  });

  it('prunes nothing without a known id list', async () => {
    const { fetchImpl, calls } = fetchFake([
      call => (call.url.endsWith('/delete_by_ids') ? {} : undefined),
    ]);
    expect(
      await pruneRemovedPaths({ ...ENV, catalog: catalogOf(1), fetchImpl }, undefined)
    ).toEqual({ deleted: [] });
    expect(await pruneRemovedPaths({ ...ENV, catalog: catalogOf(1), fetchImpl }, [])).toEqual({
      deleted: [],
    });
    expect(calls).toHaveLength(0);
  });

  it('prunes nothing when the current catalog is empty, so a bad artifact cannot empty the index', async () => {
    const { fetchImpl, calls } = fetchFake([
      call => (call.url.endsWith('/delete_by_ids') ? {} : undefined),
    ]);
    const outcome = await pruneRemovedPaths({ ...ENV, catalog: {}, fetchImpl }, [
      'proc0.list',
      'proc1.list',
    ]);
    expect(outcome).toEqual({ deleted: [] });
    expect(calls).toHaveLength(0);
  });

  it('batches deletes at PRUNE_BATCH_SIZE ids', async () => {
    const removedIds = Array.from({ length: PRUNE_BATCH_SIZE + 2 }, (_, i) => `gone${i}.list`);
    const { fetchImpl, calls } = fetchFake([
      call => (call.url.endsWith('/delete_by_ids') ? {} : undefined),
    ]);
    const outcome = await pruneRemovedPaths({ ...ENV, catalog: catalogOf(1), fetchImpl }, [
      'proc0.list',
      ...removedIds,
    ]);
    const ordered = [...removedIds].sort();
    const deletes = calls.filter(call => call.url.endsWith('/delete_by_ids'));
    expect(deletes).toHaveLength(2);
    const firstBatch: unknown = JSON.parse(deletes[0]!.body!);
    const lastBatch: unknown = JSON.parse(deletes[1]!.body!);
    if (!hasIds(firstBatch) || !hasIds(lastBatch)) throw new Error('delete body has no ids array');
    expect(firstBatch.ids).toHaveLength(PRUNE_BATCH_SIZE);
    expect(lastBatch.ids).toEqual(ordered.slice(-2));
    expect(outcome.deleted).toEqual(ordered);
  });
});

describe('loadDeleteCandidates', () => {
  it('reads the newline-delimited id list and reports none when the path is absent', () => {
    const path = join(tmpdir(), `kilo-catalog-ids-${process.pid}.txt`);
    writeFileSync(path, 'a.list\nb.get\n\n  c.create  \n');
    try {
      expect(loadDeleteCandidates(path)).toEqual(['a.list', 'b.get', 'c.create']);
      expect(loadDeleteCandidates(undefined)).toBeUndefined();
      expect(loadDeleteCandidates('')).toBeUndefined();
    } finally {
      rmSync(path, { force: true });
    }
  });
});

describe('loadCatalog', () => {
  it('reads the committed catalog.json beside the script (regression: double-encoded import.meta.url ENOENT)', () => {
    const catalog = loadCatalog();
    const rows = Object.values(catalog);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.path).toBeTruthy();
      expect(typeof row.searchBlob).toBe('string');
      expect(row.searchBlob.length).toBeGreaterThan(0);
    }
  });
});

describe('parseCatalog', () => {
  it('accepts a well-formed catalog and rejects malformed shapes', () => {
    const catalog = catalogOf(1);
    expect(parseCatalog(catalog)).toEqual(catalog);
    expect(() => parseCatalog(null)).toThrow(/JSON object/);
    expect(() => parseCatalog([])).toThrow(/JSON object/);
    expect(() => parseCatalog({ 'proc0.list': { path: 'proc0.list' } })).toThrow(/not a valid/);
    expect(() => parseCatalog({ wrong: catalog['proc0.list'] })).toThrow(/not a valid/);
  });

  it('accepts a mutation row and keeps its kind', () => {
    const mutation = rowOf('agentProfiles.create', 'mutation');
    const parsed = parseCatalog({ 'agentProfiles.create': mutation });
    expect(parsed).toEqual({ 'agentProfiles.create': mutation });
    expect(parsed['agentProfiles.create'].kind).toBe('mutation');
  });

  it('rejects an unknown kind (subscription)', () => {
    const subscription = rowOf('agentProfiles.onChanged', 'subscription');
    expect(() => parseCatalog({ 'agentProfiles.onChanged': subscription })).toThrow(/not a valid/);
  });
});
