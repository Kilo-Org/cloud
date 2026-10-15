import { describe, expect, it, vi } from 'vitest';
import type { EgressAuditRequest } from '../shared/egress-audit.js';
import { getEgressAudit, recordEgressRequest } from './egress-audit.js';

function storageFixture() {
  const map = new Map<string, unknown>();
  const get = vi.fn(
    async (keys: string[]) =>
      new Map(keys.filter(key => map.has(key)).map(key => [key, structuredClone(map.get(key))]))
  );
  const put = vi.fn(async (entries: Record<string, unknown>) => {
    for (const [key, value] of Object.entries(entries)) map.set(key, structuredClone(value));
  });
  const list = vi.fn(async (options: DurableObjectListOptions) => {
    const rows = [...map.entries()]
      .filter(([key]) => key.startsWith(options.prefix ?? '') && key > (options.startAfter ?? ''))
      .sort(([left], [right]) => left.localeCompare(right))
      .slice(0, options.limit);
    return new Map(rows);
  });
  const storage = { get, put, list } as unknown as Pick<
    DurableObjectStorage,
    'get' | 'put' | 'list'
  >;
  return { storage, map, get, put, list };
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

describe('durable egress audit storage', () => {
  it('commits a bounded sanitized record, counter, and deduplication identity together', async () => {
    const { storage, map, put } = storageFixture();
    const input = request();
    const record = await recordEgressRequest(storage, {
      ...input,
      url: 'https://user:secret@example.com/private?token=secret',
      headers: { Authorization: 'Bearer secret' },
      body: 'secret',
      error: 'secret',
    });
    expect(record).toEqual({ ...input, id: 1 });
    expect(put).toHaveBeenCalledTimes(1);
    expect(map.size).toBe(3);
    expect(JSON.stringify([...map])).not.toContain('secret');
    expect(await getEgressAudit(storage)).toEqual({ records: [record], nextCursor: null });
  });

  it('does not allocate another id after an ambiguous committed write or reconstructed helper', async () => {
    const { storage, put } = storageFixture();
    const input = request();
    const originalPut = put.getMockImplementation();
    put.mockImplementationOnce(async entries => {
      await originalPut?.(entries);
      throw new Error('reply lost after commit');
    });
    await expect(recordEgressRequest(storage, input)).rejects.toThrow('reply lost');
    const retried = await recordEgressRequest({ ...storage }, input);
    expect(retried.id).toBe(1);
    expect((await recordEgressRequest(storage, request())).id).toBe(2);
    expect((await getEgressAudit(storage)).records.map(record => record.id)).toEqual([1, 2]);
  });

  it('retains records across allocations and paginates numeric ids in ascending order', async () => {
    const { storage, list } = storageFixture();
    for (let index = 0; index < 125; index++) {
      await recordEgressRequest(storage, request({ allocationRef: `allocation-${index % 2}` }));
    }
    const first = await getEgressAudit(storage, { limit: 10 });
    expect(first.records.map(record => record.id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(first.nextCursor).toBe(10);
    expect(list).toHaveBeenLastCalledWith(expect.objectContaining({ limit: 11 }));
    const second = await getEgressAudit({ ...storage }, { cursor: 10, limit: 100 });
    expect(second.records).toHaveLength(100);
    expect(second.records[0]?.id).toBe(11);
    expect(second.nextCursor).toBe(110);
    const last = await getEgressAudit(storage, { cursor: second.nextCursor ?? 0, limit: 100 });
    expect(last.records.map(record => record.id)).toEqual([
      111, 112, 113, 114, 115, 116, 117, 118, 119, 120, 121, 122, 123, 124, 125,
    ]);
    expect(last.nextCursor).toBeNull();
    expect((await getEgressAudit(storage)).records).toHaveLength(50);
    expect(await getEgressAudit(storage, { cursor: 125 })).toEqual({
      records: [],
      nextCursor: null,
    });
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
  ])('rejects invalid external metadata before writing: %j', async invalid => {
    const { storage, get, put } = storageFixture();
    await expect(recordEgressRequest(storage, { ...request(), ...invalid })).rejects.toThrow();
    expect(get).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
  });

  it.each([{ cursor: -1 }, { cursor: 0.5 }, { limit: 0 }, { limit: 101 }, { limit: NaN }])(
    'rejects invalid page bounds without reading rows: %j',
    async input => {
      const { storage, list } = storageFixture();
      await expect(getEgressAudit(storage, input)).rejects.toThrow();
      expect(list).not.toHaveBeenCalled();
    }
  );

  it('does not reuse a sequence when persistence fails before committing', async () => {
    const { storage, put } = storageFixture();
    await recordEgressRequest(storage, request());
    put.mockRejectedValueOnce(new Error('storage unavailable'));
    const input = request();
    await expect(recordEgressRequest(storage, input)).rejects.toThrow('storage unavailable');
    expect((await recordEgressRequest(storage, input)).id).toBe(2);
  });
});
