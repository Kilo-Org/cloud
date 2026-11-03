import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EgressAuditRequest } from '../shared/egress-audit.js';
import { EgressAuditStore } from './egress-audit.js';

const PREFIX = 'containers:egress-audit:chunk:';
const NOW = Date.parse('2026-10-19T12:00:00.000Z');

function chunkKey(number: number): string {
  return `${PREFIX}${String(number).padStart(16, '0')}`;
}

function storageFixture() {
  const map = new Map<string, unknown>();
  const put = vi.fn(async (key: string, value: unknown) => {
    map.set(key, structuredClone(value));
  });
  const list = vi.fn(async (options: DurableObjectListOptions) => {
    const rows = [...map.entries()]
      .filter(([key]) => key.startsWith(options.prefix ?? ''))
      .sort(([left], [right]) => left.localeCompare(right))
      .slice(0, options.limit);
    return new Map(structuredClone(rows));
  });
  let staged = new Map<string, unknown>();
  const transactionPut = vi.fn(async (key: string, value: unknown) => {
    staged.set(key, structuredClone(value));
  });
  const transactionDelete = vi.fn(async (key: string) => staged.delete(key));
  const transaction = vi.fn(async (task: (txn: DurableObjectTransaction) => Promise<unknown>) => {
    staged = new Map(map);
    await task({
      put: transactionPut,
      delete: transactionDelete,
    } as unknown as DurableObjectTransaction);
    map.clear();
    for (const [key, value] of staged) map.set(key, value);
  });
  const storage = { put, list, transaction } as unknown as Pick<
    DurableObjectStorage,
    'put' | 'list' | 'transaction'
  >;
  return {
    store: new EgressAuditStore(storage),
    storage,
    map,
    put,
    list,
    transaction,
    transactionPut,
    transactionDelete,
  };
}

function request(overrides: Partial<EgressAuditRequest> = {}): EgressAuditRequest {
  return {
    requestId: crypto.randomUUID(),
    allocationRef: 'allocation-1',
    timestamp: '2026-10-15T15:00:00.000Z',
    method: 'POST',
    hostname: 'example.com',
    protocol: 'https:',
    port: 443,
    decision: 'allowed',
    ...overrides,
  };
}

function seedChunks(
  map: Map<string, unknown>,
  { count = 256, start = 0, lastSize = 64, committedAt = NOW - 60_000 } = {}
) {
  const chunks = Array.from({ length: count }, (_, index) => ({
    records: Array.from({ length: index === count - 1 ? lastSize : 64 }, (_, offset) => ({
      ...request(),
      id: (start + index) * 64 + offset + 1,
    })),
    lastCommittedAtMs: committedAt,
  }));
  for (const [index, chunk] of chunks.entries()) map.set(chunkKey(start + index), chunk);
  return chunks;
}

afterEach(() => vi.restoreAllMocks());

describe('durable egress audit storage', () => {
  it('persists sanitized records once with one row write per warm append and one bounded cold read', async () => {
    const { store, map, put, list, transaction } = storageFixture();
    const input = request();
    const record = await store.recordEgressRequest({
      ...input,
      url: 'https://user:secret@example.com/private?token=secret',
      headers: { Authorization: 'Bearer secret' },
      body: 'secret',
      error: 'secret',
    });
    expect(record).toEqual({ ...input, id: 1 });
    expect(put).toHaveBeenCalledTimes(1);
    expect(map.size).toBe(1);
    expect(JSON.stringify([...map])).not.toContain('secret');
    const next = await store.recordEgressRequest(request());
    expect(put).toHaveBeenCalledTimes(2);
    expect(put.mock.calls.every(call => typeof call[0] === 'string' && call.length === 2)).toBe(
      true
    );
    expect(transaction).not.toHaveBeenCalled();
    expect(list).toHaveBeenCalledExactlyOnceWith({ prefix: PREFIX, limit: 257 });
    expect([...map.values()]).toEqual([
      {
        records: [record, next],
        lastCommittedAtMs: expect.any(Number),
      },
    ]);
    expect(await store.getEgressAudit()).toEqual({ records: [record, next], nextCursor: null });
    expect(list).toHaveBeenCalledTimes(1);
  });

  it('serializes concurrent cold and warm appends and deduplicates without reads or writes', async () => {
    const { store, map, put, list, transaction } = storageFixture();
    const input = request();
    const repeated = await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        store.recordEgressRequest({
          ...input,
          requestId: index % 2 ? input.requestId.toUpperCase() : input.requestId,
        })
      )
    );
    expect(repeated).toEqual(Array.from({ length: 20 }, () => ({ ...input, id: 1 })));
    expect(put).toHaveBeenCalledTimes(1);
    const records = await Promise.all(
      Array.from({ length: 70 }, () => store.recordEgressRequest(request()))
    );
    expect(records.map(record => record.id)).toEqual(
      Array.from({ length: 70 }, (_, index) => index + 2)
    );
    expect(await store.recordEgressRequest({ ...input, hostname: 'changed.example.com' })).toEqual(
      repeated[0]
    );
    expect(put).toHaveBeenCalledTimes(71);
    expect(list).toHaveBeenCalledTimes(1);
    expect(transaction).not.toHaveBeenCalled();
    expect(map.size).toBe(2);
  });

  it('does not acknowledge or expose a new record before its write resolves', async () => {
    const { store, put } = storageFixture();
    let release = () => {};
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    const originalPut = put.getMockImplementation();
    put.mockImplementationOnce(async (key, value) => {
      await gate;
      await originalPut?.(key, value);
    });
    const acknowledged = vi.fn();
    const input = request();
    const pending = store.recordEgressRequest(input).then(acknowledged);
    const duplicate = store.recordEgressRequest(input);
    const page = store.getEgressAudit();
    await vi.waitFor(() => expect(put).toHaveBeenCalledTimes(1));
    expect(acknowledged).not.toHaveBeenCalled();
    release();
    await pending;
    expect(await duplicate).toEqual({ ...input, id: 1 });
    expect(await page).toEqual({ records: [{ ...input, id: 1 }], nextCursor: null });
    expect(put).toHaveBeenCalledTimes(1);
  });

  it('reloads after an ambiguous put and deduplicates on the same instance and after reconstruction', async () => {
    const { store, storage, put, list } = storageFixture();
    const input = request();
    const originalPut = put.getMockImplementation();
    put.mockImplementationOnce(async (key, value) => {
      await originalPut?.(key, value);
      throw new Error('reply lost after commit');
    });
    await expect(store.recordEgressRequest(input)).rejects.toThrow('reply lost');
    expect(await store.recordEgressRequest(input)).toEqual({ ...input, id: 1 });
    expect(put).toHaveBeenCalledTimes(1);
    expect(list).toHaveBeenCalledTimes(2);
    const restored = new EgressAuditStore(storage);
    expect((await restored.recordEgressRequest(input)).id).toBe(1);
    expect((await restored.recordEgressRequest(request())).id).toBe(2);
  });

  it('reloads the committed high-water id when a put fails before committing', async () => {
    const { store, put, list } = storageFixture();
    await store.recordEgressRequest(request());
    put.mockRejectedValueOnce(new Error('storage unavailable'));
    const input = request();
    await expect(store.recordEgressRequest(input)).rejects.toThrow('storage unavailable');
    expect((await store.recordEgressRequest(input)).id).toBe(2);
    expect(list).toHaveBeenCalledTimes(2);
  });

  it('retains records across chunks and allocations and paginates exclusive numeric ids', async () => {
    const { store, storage, map } = storageFixture();
    for (let index = 0; index < 125; index++) {
      await store.recordEgressRequest(request({ allocationRef: `allocation-${index % 2}` }));
    }
    expect(map.size).toBe(2);
    const first = await store.getEgressAudit({ limit: 10 });
    expect(first.records.map(record => record.id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(first.nextCursor).toBe(10);
    const restored = new EgressAuditStore(storage);
    const second = await restored.getEgressAudit({ cursor: 10, limit: 100 });
    expect(second.records).toHaveLength(100);
    expect(second.records[0]?.id).toBe(11);
    expect(second.nextCursor).toBe(110);
    const last = await restored.getEgressAudit({ cursor: second.nextCursor ?? 0, limit: 100 });
    expect(last.records.map(record => record.id)).toEqual(
      Array.from({ length: 15 }, (_, index) => index + 111)
    );
    expect(last.nextCursor).toBeNull();
    expect((await store.getEgressAudit()).records).toHaveLength(50);
    expect(await store.getEgressAudit({ cursor: 125 })).toEqual({ records: [], nextCursor: null });
  });

  it('atomically prunes only the oldest chunk, bounds deduplication, and preserves cursors and ids after eviction', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const { store, storage, map, put, transaction, transactionPut, transactionDelete } =
      storageFixture();
    const chunks = seedChunks(map);
    const pruned = chunks[0].records[0];
    const retained = chunks[1].records[0];
    map.set('containers:record:v1', { state: 'running' });
    map.set('containers:billing-schedules:v1', [{ callback: 'billing-generation' }]);
    expect(await store.recordEgressRequest(pruned)).toEqual(pruned);
    expect(put).not.toHaveBeenCalled();
    const next = await store.recordEgressRequest(request());
    expect(next.id).toBe(16_385);
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(transactionPut).toHaveBeenCalledExactlyOnceWith(chunkKey(256), {
      records: [next],
      lastCommittedAtMs: NOW,
    });
    expect(transactionDelete).toHaveBeenCalledExactlyOnceWith(chunkKey(0));
    expect(map.size).toBe(258);
    expect(map.has(chunkKey(0))).toBe(false);
    expect(map.get('containers:record:v1')).toEqual({ state: 'running' });
    expect(map.get('containers:billing-schedules:v1')).toEqual([
      { callback: 'billing-generation' },
    ]);
    expect(await store.getEgressAudit({ cursor: 1, limit: 2 })).toEqual({
      records: chunks[1].records.slice(0, 2),
      nextCursor: 66,
    });
    expect((await store.recordEgressRequest(pruned)).id).toBe(16_386);
    const restored = new EgressAuditStore(storage);
    expect(await restored.recordEgressRequest(retained)).toEqual(retained);
    expect((await restored.recordEgressRequest(pruned)).id).toBe(16_386);
    expect((await restored.recordEgressRequest(request())).id).toBe(16_387);
    expect(await restored.getEgressAudit({ cursor: 16_383 })).toMatchObject({
      records: [{ id: 16_384 }, { id: 16_385 }, { id: 16_386 }, { id: 16_387 }],
      nextCursor: null,
    });
    expect(map.size).toBe(258);
  });

  it('protects recently committed chunks regardless of request timestamp and recovers after 60 seconds', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(NOW + 59_999);
    const { store, map, transaction } = storageFixture();
    const chunks = seedChunks(map, { committedAt: NOW });
    const input = request();
    await expect(store.recordEgressRequest(input)).rejects.toThrow(
      'capacity reached within retry retention'
    );
    expect(await store.recordEgressRequest(chunks[0].records[63])).toEqual(chunks[0].records[63]);
    expect(transaction).not.toHaveBeenCalled();
    expect(map.size).toBe(256);
    clock.mockReturnValue(NOW + 60_000);
    expect((await store.recordEgressRequest(input)).id).toBe(16_385);
    expect(map.size).toBe(256);
    expect(transaction).toHaveBeenCalledTimes(1);
  });

  it('reloads after an ambiguous committed rollover without double pruning or allocating another id', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const { store, map, transaction, list } = storageFixture();
    seedChunks(map);
    const originalTransaction = transaction.getMockImplementation();
    transaction.mockImplementationOnce(async task => {
      await originalTransaction?.(task);
      throw new Error('transaction reply lost');
    });
    const input = request();
    await expect(store.recordEgressRequest(input)).rejects.toThrow('transaction reply lost');
    expect((await store.recordEgressRequest(input)).id).toBe(16_385);
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(list).toHaveBeenCalledTimes(2);
    expect((await store.getEgressAudit({ limit: 1 })).records[0]?.id).toBe(65);
    expect((await store.recordEgressRequest(request())).id).toBe(16_386);
    expect(map.size).toBe(256);
  });

  it('rolls back both rollover operations on deletion failure and reloads before retrying', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const { store, map, transaction, transactionDelete, list } = storageFixture();
    seedChunks(map);
    transactionDelete.mockRejectedValueOnce(new Error('delete failed'));
    const input = request();
    await expect(store.recordEgressRequest(input)).rejects.toThrow('delete failed');
    expect(map.has(chunkKey(0))).toBe(true);
    expect(map.has(chunkKey(256))).toBe(false);
    expect(
      (await store.getEgressAudit({ cursor: 16_383 })).records.map(record => record.id)
    ).toEqual([16_384]);
    expect(list).toHaveBeenCalledTimes(2);
    expect((await store.recordEgressRequest(input)).id).toBe(16_385);
    expect(transaction).toHaveBeenCalledTimes(2);
    expect(map.size).toBe(256);
  });

  it('keeps caller mutations out of the cached records', async () => {
    const { store } = storageFixture();
    const input = request();
    const record = await store.recordEgressRequest(input);
    record.id = 100;
    const page = await store.getEgressAudit();
    page.records[0].hostname = 'changed.example.com';
    expect(await store.recordEgressRequest(input)).toEqual({ ...input, id: 1 });
  });

  it.each([
    { requestId: 'not-a-uuid' },
    { allocationRef: 'x'.repeat(513) },
    { hostname: 'user:secret@example.com/path?token=secret' },
    { hostname: 'x'.repeat(254) },
    { method: 'GET\nAuthorization: secret' },
    { protocol: 'ftp:' },
    { port: 0 },
    { port: 65536 },
    { decision: 'unknown' },
    { timestamp: 'yesterday' },
  ])('rejects invalid external metadata before accessing storage: %j', async invalid => {
    const { store, list, put } = storageFixture();
    await expect(store.recordEgressRequest({ ...request(), ...invalid })).rejects.toThrow();
    expect(list).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
  });

  it.each([
    { cursor: -1 },
    { cursor: 0.5 },
    { cursor: Number.MAX_SAFE_INTEGER + 1 },
    { limit: 0 },
    { limit: 101 },
    { limit: NaN },
  ])('rejects invalid page bounds without reading rows: %j', async input => {
    const { store, list } = storageFixture();
    await expect(store.getEgressAudit(input)).rejects.toThrow();
    expect(list).not.toHaveBeenCalled();
  });

  it.each([
    'empty',
    'oversized',
    'bad timestamp',
    'unsafe id',
    'wrong key',
    'inner gap',
    'missing chunk',
    'partial interior chunk',
    'duplicate request',
    'unsanitized record',
  ])('rejects corrupt persisted history without writing: %s', async corruption => {
    const { store, map, put } = storageFixture();
    const chunks = seedChunks(map, { count: 3 });
    switch (corruption) {
      case 'empty':
        chunks[0].records = [];
        break;
      case 'oversized':
        chunks[0].records.push({ ...request(), id: 65 });
        break;
      case 'bad timestamp':
        chunks[0].lastCommittedAtMs = NaN;
        break;
      case 'unsafe id':
        chunks[0].records[0].id = Number.MAX_SAFE_INTEGER + 1;
        break;
      case 'wrong key':
        map.set(chunkKey(3), chunks[0]);
        map.delete(chunkKey(0));
        break;
      case 'inner gap':
        chunks[0].records.splice(10, 1);
        break;
      case 'missing chunk':
        map.delete(chunkKey(1));
        break;
      case 'partial interior chunk':
        chunks[0].records.pop();
        break;
      case 'duplicate request':
        chunks[1].records[0].requestId = chunks[0].records[0].requestId;
        break;
      case 'unsanitized record':
        Object.assign(chunks[0].records[0], { url: 'https://secret' });
        break;
    }
    await expect(store.recordEgressRequest(request())).rejects.toThrow();
    await expect(store.getEgressAudit()).rejects.toThrow();
    expect(put).not.toHaveBeenCalled();
  });

  it('rejects overflow instead of silently truncating a cold read', async () => {
    const { store, map, list, put } = storageFixture();
    seedChunks(map, { count: 257 });
    await expect(store.getEgressAudit()).rejects.toThrow('chunk limit exceeded');
    expect(list).toHaveBeenCalledExactlyOnceWith({ prefix: PREFIX, limit: 257 });
    expect(put).not.toHaveBeenCalled();
  });

  it('preserves the safe-integer high-water id and rejects exhaustion without losing deduplication', async () => {
    const { store, map, put } = storageFixture();
    const [chunk] = seedChunks(map, {
      count: 1,
      start: Math.floor((Number.MAX_SAFE_INTEGER - 1) / 64),
      lastSize: 63,
    });
    const last = chunk.records[62];
    expect(last.id).toBe(Number.MAX_SAFE_INTEGER);
    expect(await store.recordEgressRequest(last)).toEqual(last);
    await expect(store.recordEgressRequest(request())).rejects.toThrow('id exhausted');
    expect(await store.getEgressAudit({ cursor: Number.MAX_SAFE_INTEGER - 1 })).toEqual({
      records: [last],
      nextCursor: null,
    });
    expect(put).not.toHaveBeenCalled();
  });
});
