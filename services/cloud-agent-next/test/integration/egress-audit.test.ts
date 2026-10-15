import { env, evictDurableObject, reset, runInDurableObject } from 'cloudflare:test';
import { afterEach, describe, expect, it } from 'vitest';
import { SandboxContainers } from '../../src/sandbox-containers/SandboxContainers.js';
import { encodeCloudflareProviderRef } from '../../src/sandbox-control/cloudflare-provider.js';
import type { EgressAuditRequest } from '../../src/shared/egress-audit.js';

const sandboxId = 'sbx__egress_audit';
const allocationRefs = ['first', 'second', 'third'].map(instanceId =>
  encodeCloudflareProviderRef({ sandboxId, containment: false, instanceId })
);

function request(overrides: Partial<EgressAuditRequest> = {}): EgressAuditRequest {
  return {
    requestId: crypto.randomUUID(),
    allocationRef: allocationRefs[0],
    timestamp: '2026-10-15T15:00:00.000Z',
    method: 'POST',
    hostname: 'example.com',
    protocol: 'https:',
    port: 443,
    decision: 'allowed',
    ...overrides,
  };
}

afterEach(async () => {
  await reset();
});

describe('SandboxContainers egress audit RPC storage', () => {
  it('runs the actual Durable Object without a container and persists sanitized records', async () => {
    const stub = env.SANDBOX_CONTAINERS.getByName(sandboxId);
    await runInDurableObject(stub, (instance, state) => {
      expect(instance).toBeInstanceOf(SandboxContainers);
      expect(state.container).toBeUndefined();
    });
    await expect(stub.getEgressAudit()).resolves.toEqual({ records: [], nextCursor: null });

    const input = request();
    const record = await stub.recordEgressRequest({
      ...input,
      url: 'https://user:secret@example.com/private?token=secret',
      headers: { Authorization: 'Bearer secret' },
      body: 'secret',
      error: 'secret',
    });
    expect(record).toEqual({ ...input, id: 1 });
    await expect(stub.getEgressAudit()).resolves.toEqual({ records: [record], nextCursor: null });
    const persisted = await runInDurableObject(stub, (_instance, state) => state.storage.list());
    expect(persisted.size).toBe(3);
    expect(JSON.stringify([...persisted])).not.toContain('secret');
  });

  it('assigns unique monotonic ids to concurrent RPCs on cold and warm storage', async () => {
    const stub = env.SANDBOX_CONTAINERS.getByName(sandboxId);
    const expected = [];
    for (let batch = 0; batch < 2; batch++) {
      const inputs = Array.from({ length: 32 }, (_, index) =>
        request({
          allocationRef: allocationRefs[index % allocationRefs.length],
          decision: index % 2 === 0 ? 'allowed' : 'denied',
        })
      );
      const records = await Promise.all(inputs.map(input => stub.recordEgressRequest(input)));
      expect(records.map(record => record.id).sort((left, right) => left - right)).toEqual(
        Array.from({ length: inputs.length }, (_, index) => batch * inputs.length + index + 1)
      );
      for (const [index, record] of records.entries()) {
        expect(record).toEqual({ ...inputs[index], id: record.id });
      }
      expected.push(...records);
    }
    expect(new Set(expected.map(record => record.id)).size).toBe(64);
    await expect(stub.getEgressAudit({ limit: 100 })).resolves.toEqual({
      records: expected.sort((left, right) => left.id - right.id),
      nextCursor: null,
    });
    expect((await stub.recordEgressRequest(request())).id).toBe(65);
  });

  it('deduplicates concurrent repeated request ids including normalized UUID casing', async () => {
    const stub = env.SANDBOX_CONTAINERS.getByName(sandboxId);
    const input = request({ requestId: 'abcdefab-cdef-4abc-8def-abcdefabcdef' });
    const records = await Promise.all(
      Array.from({ length: 24 }, (_, index) =>
        stub.recordEgressRequest({
          ...input,
          requestId: index % 2 === 0 ? input.requestId : input.requestId.toUpperCase(),
        })
      )
    );
    for (const record of records) expect(record).toEqual({ ...input, id: 1 });
    await expect(stub.getEgressAudit()).resolves.toEqual({
      records: [{ ...input, id: 1 }],
      nextCursor: null,
    });
    expect((await stub.recordEgressRequest(request())).id).toBe(2);
  });

  it('replays an ambiguously acknowledged write after eviction without overwriting or consuming an id', async () => {
    let stub = env.SANDBOX_CONTAINERS.getByName(sandboxId);
    const input = request();
    await expect(
      stub.recordEgressRequest(input).then(() => {
        throw new Error('caller lost the committed RPC reply');
      })
    ).rejects.toThrow('caller lost the committed RPC reply');

    await evictDurableObject(stub);
    stub = env.SANDBOX_CONTAINERS.getByName(sandboxId);
    const original = { ...input, id: 1 };
    await expect(stub.recordEgressRequest(input)).resolves.toEqual(original);
    await expect(
      stub.recordEgressRequest({
        ...input,
        allocationRef: allocationRefs[1],
        timestamp: '2026-10-15T16:00:00.000Z',
        hostname: 'changed.example.com',
        decision: 'denied',
      })
    ).resolves.toEqual(original);
    const next = await stub.recordEgressRequest(request({ allocationRef: allocationRefs[1] }));
    expect(next.id).toBe(2);
    await expect(stub.getEgressAudit()).resolves.toEqual({
      records: [original, next],
      nextCursor: null,
    });
  });

  it('returns deterministic numeric-id pages with exclusive cursors and bounded page sizes', async () => {
    const stub = env.SANDBOX_CONTAINERS.getByName(sandboxId);
    const expected = [];
    for (let index = 0; index < 125; index++) {
      expected.push(
        await stub.recordEgressRequest(
          request({
            allocationRef: allocationRefs[index % allocationRefs.length],
            timestamp: new Date(
              Date.parse('2026-10-15T15:00:00.000Z') - index * 1000
            ).toISOString(),
          })
        )
      );
    }

    await expect(stub.getEgressAudit()).resolves.toEqual({
      records: expected.slice(0, 50),
      nextCursor: 50,
    });
    const first = await stub.getEgressAudit({ limit: 10 });
    expect(first).toEqual({ records: expected.slice(0, 10), nextCursor: 10 });
    await expect(stub.getEgressAudit({ limit: 10 })).resolves.toEqual(first);

    const second = await stub.getEgressAudit({ cursor: first.nextCursor ?? 0, limit: 100 });
    expect(second).toEqual({ records: expected.slice(10, 110), nextCursor: 110 });
    const last = await stub.getEgressAudit({ cursor: second.nextCursor ?? 0, limit: 100 });
    expect(last).toEqual({ records: expected.slice(110), nextCursor: null });
    expect([...first.records, ...second.records, ...last.records]).toEqual(expected);
    await expect(stub.getEgressAudit({ cursor: 115, limit: 10 })).resolves.toEqual({
      records: expected.slice(115),
      nextCursor: null,
    });
    for (const cursor of [125, 126, Number.MAX_SAFE_INTEGER]) {
      await expect(stub.getEgressAudit({ cursor })).resolves.toEqual({
        records: [],
        nextCursor: null,
      });
    }
  });

  it('retains all allocation records, the cursor, and the sequence across reconstruction', async () => {
    let stub = env.SANDBOX_CONTAINERS.getByName(sandboxId);
    const first = await stub.recordEgressRequest(request());
    const second = await stub.recordEgressRequest(request({ allocationRef: allocationRefs[1] }));
    const page = await stub.getEgressAudit({ limit: 1 });
    expect(page).toEqual({ records: [first], nextCursor: 1 });

    await evictDurableObject(stub);
    stub = env.SANDBOX_CONTAINERS.getByName(sandboxId);
    await expect(stub.getEgressAudit({ limit: 1 })).resolves.toEqual(page);
    await expect(stub.recordEgressRequest(first)).resolves.toEqual(first);
    const third = await stub.recordEgressRequest(request({ allocationRef: allocationRefs[2] }));
    expect(third.id).toBe(3);
    await expect(stub.getEgressAudit({ cursor: page.nextCursor ?? 0 })).resolves.toEqual({
      records: [second, third],
      nextCursor: null,
    });

    await evictDurableObject(stub);
    stub = env.SANDBOX_CONTAINERS.getByName(sandboxId);
    await expect(stub.getEgressAudit()).resolves.toEqual({
      records: [first, second, third],
      nextCursor: null,
    });
    expect((await stub.recordEgressRequest(request())).id).toBe(4);
  });
});
