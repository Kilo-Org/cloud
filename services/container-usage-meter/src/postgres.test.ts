import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkerDb } from '@kilocode/db';
import type { RecordStartInput } from '@kilocode/container-usage';
import type * as CapacityModule from '@kilocode/container-usage/capacity';
import { lockContainerCapacity, readContainerCapacity } from '@kilocode/container-usage/capacity';
import { applyStartWithDb, type StartSkuAdmission } from './postgres';

vi.mock('@kilocode/container-usage/capacity', async importOriginal => ({
  ...(await importOriginal<typeof CapacityModule>()),
  lockContainerCapacity: vi.fn(),
  readContainerCapacity: vi.fn(),
}));

const start: RecordStartInput = {
  service: 'cloud-agent-next-test',
  instanceId: 'sbx-1',
  sku: 'sandbox-sku',
  subject: { type: 'user', id: 'oauth/github:actor-1' },
  actor: { type: 'user', id: 'oauth/github:actor-1' },
  startEpochMs: 123,
  idempotencyKey: 'v1:cloud-agent-next-test:sbx-1:123:start',
  admission: { checkpoint: 'sandbox-start' },
};
const id = 'cloud-agent-next-test:sbx-1:123';
const fingerprint = 'a'.repeat(64);
const sku = { unit: 'second', acceptsNewUsage: true, rateCentsPerUnit: '1' };
const existingInterval = {
  id,
  service: start.service,
  instance_id: start.instanceId,
  cloud_billing_sku_id: start.sku,
  context_fingerprint: fingerprint,
  started_at: '1970-01-01T00:00:01.000Z',
  last_seen_at: '1970-01-01T00:00:01.000Z',
  status: 'open',
  billing_mode: 'shadow',
  capacityLive: true,
};
type Transaction = Parameters<Parameters<WorkerDb['transaction']>[0]>[0];

function database(selections: unknown[][] = [[], [sku], []], insertFailure?: Error) {
  const events: string[] = [];
  const select = vi.fn(() => {
    events.push('select');
    const query = Object.assign(Promise.resolve(selections.shift() ?? []), {
      from: () => query,
      where: () => query,
      for: () => query,
      limit: () => query,
    });
    return query;
  });
  const returning = vi.fn(async () => {
    events.push('insert');
    if (insertFailure) throw insertFailure;
    return [{ id }];
  });
  const values = vi.fn(() => ({ onConflictDoNothing: () => ({ returning }) }));
  const insert = vi.fn(() => ({ values }));
  const set = vi.fn(() => ({
    where: async () => {
      events.push('renew');
    },
  }));
  const update = vi.fn(() => ({ set }));
  const tx = { select, insert, update } as unknown as Transaction;
  const transaction = vi.fn(
    async (operation: (tx: Transaction) => Promise<StartSkuAdmission>, _config?: unknown) => {
      events.push('begin');
      try {
        const result = await operation(tx);
        events.push('commit');
        return result;
      } catch (error) {
        events.push('rollback');
        throw error;
      }
    }
  );
  return {
    db: { transaction } as unknown as WorkerDb,
    tx,
    transaction,
    select,
    insert,
    update,
    values,
    returning,
    set,
    events,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(lockContainerCapacity).mockResolvedValue(undefined);
  vi.mocked(readContainerCapacity).mockResolvedValue([
    { subject: start.subject, live: 2, limit: 3 },
  ]);
});

describe('transactional start admission', () => {
  it('awaits scope locks before any reads, then checks and inserts before committing', async () => {
    const fixture = database();
    const gate = Promise.withResolvers<void>();
    vi.mocked(lockContainerCapacity).mockImplementation(async () => {
      fixture.events.push('lock');
      await gate.promise;
    });
    vi.mocked(readContainerCapacity).mockImplementation(async () => {
      fixture.events.push('capacity');
      return [{ subject: start.subject, live: 2, limit: 3 }];
    });
    const operation = applyStartWithDb(fixture.db, start, id, fingerprint, 1_000);
    expect(fixture.select).not.toHaveBeenCalled();
    expect(fixture.insert).not.toHaveBeenCalled();
    gate.resolve();
    await expect(operation).resolves.toEqual({
      kind: 'applied',
      dedup: false,
      billingMode: 'shadow',
    });
    expect(fixture.transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: 'read committed',
    });
    const request = {
      subject: start.subject,
      actor: start.actor,
      instanceId: start.instanceId,
      checkpoint: 'sandbox-start',
      billingOrigin: undefined,
    };
    expect(lockContainerCapacity).toHaveBeenCalledWith(fixture.tx, request);
    expect(readContainerCapacity).toHaveBeenCalledWith(fixture.tx, request);
    expect(fixture.events).toEqual([
      'begin',
      'lock',
      'select',
      'select',
      'select',
      'capacity',
      'insert',
      'commit',
    ]);
    expect(fixture.values).toHaveBeenCalledWith(
      expect.objectContaining({
        started_at: '1970-01-01T00:00:01.000Z',
        last_seen_at: '1970-01-01T00:00:01.000Z',
      })
    );
  });

  it.each(['shadow', 'paid'] as const)(
    'renews an exact live %s interval without rechecking capacity or changing billing',
    async billingMode => {
      const existing = { ...existingInterval, billing_mode: billingMode };
      const fixture = database([[existing], [{ remaining: 0 }]]);
      vi.mocked(readContainerCapacity).mockResolvedValue([
        { subject: start.subject, live: 4, limit: 3 },
      ]);
      await expect(applyStartWithDb(fixture.db, start, id, fingerprint, 60_000)).resolves.toEqual({
        kind: 'applied',
        dedup: true,
        billingMode,
        ...(billingMode === 'paid' ? { remainingMicrodollars: 0 } : {}),
      });
      expect(lockContainerCapacity).toHaveBeenCalledOnce();
      expect(readContainerCapacity).not.toHaveBeenCalled();
      expect(fixture.insert).not.toHaveBeenCalled();
      expect(fixture.update).toHaveBeenCalledOnce();
      expect(fixture.set).toHaveBeenCalledWith({ last_seen_at: expect.anything() });
    }
  );

  it('rejects closed admission without reopening or refreshing the row', async () => {
    const fixture = database([[{ ...existingInterval, status: 'closed', capacityLive: false }]]);
    await expect(
      applyStartWithDb(fixture.db, start, id, fingerprint, 60_000)
    ).resolves.toMatchObject({
      kind: 'rejected',
      code: 'interval_closed',
    });
    expect(lockContainerCapacity).toHaveBeenCalledOnce();
    expect(readContainerCapacity).not.toHaveBeenCalled();
    expect(fixture.update).not.toHaveBeenCalled();
    expect(fixture.insert).not.toHaveBeenCalled();
  });

  it('retains ordinary closed-interval replay for recovery without renewal or capacity reads', async () => {
    const fixture = database([[{ ...existingInterval, status: 'closed', capacityLive: false }]]);
    await expect(
      applyStartWithDb(fixture.db, { ...start, admission: undefined }, id, fingerprint, 60_000)
    ).resolves.toEqual({
      kind: 'applied',
      dedup: true,
      billingMode: 'shadow',
    });
    expect(lockContainerCapacity).not.toHaveBeenCalled();
    expect(readContainerCapacity).not.toHaveBeenCalled();
    expect(fixture.update).not.toHaveBeenCalled();
    expect(fixture.insert).not.toHaveBeenCalled();
  });

  it.each([
    [{ type: 'user', id: start.actor.id }, 3],
    [{ type: 'org', id: 'org-1' }, 50],
  ] as const)('refuses to renew a stale interval when scope %j is full', async (subject, limit) => {
    const fixture = database([[{ ...existingInterval, capacityLive: false }]]);
    vi.mocked(readContainerCapacity).mockResolvedValue([{ subject, live: limit, limit }]);
    await expect(
      applyStartWithDb(fixture.db, start, id, fingerprint, 60_000)
    ).resolves.toMatchObject({
      kind: 'rejected',
      code: 'container_limit_reached',
      limit,
    });
    expect(readContainerCapacity).toHaveBeenCalledOnce();
    expect(fixture.update).not.toHaveBeenCalled();
    expect(fixture.insert).not.toHaveBeenCalled();
  });

  it.each(['shadow', 'paid'] as const)(
    'rechecks capacity and renews the same stale %s interval when a slot is free',
    async billingMode => {
      const fixture = database([
        [{ ...existingInterval, billing_mode: billingMode, capacityLive: false }],
        [{ remaining: 0 }],
      ]);
      vi.mocked(readContainerCapacity).mockImplementation(async () => {
        fixture.events.push('capacity');
        return [{ subject: start.subject, live: 2, limit: 3 }];
      });
      await expect(applyStartWithDb(fixture.db, start, id, fingerprint, 60_000)).resolves.toEqual({
        kind: 'applied',
        dedup: true,
        billingMode,
        ...(billingMode === 'paid' ? { remainingMicrodollars: 0 } : {}),
      });
      expect(readContainerCapacity).toHaveBeenCalledOnce();
      expect(fixture.update).toHaveBeenCalledOnce();
      expect(fixture.set).toHaveBeenCalledWith({ last_seen_at: expect.anything() });
      expect(fixture.insert).not.toHaveBeenCalled();
      expect(fixture.events.indexOf('capacity')).toBeLessThan(fixture.events.indexOf('renew'));
      expect(fixture.events.at(-1)).toBe('commit');
    }
  );

  it('also rejects a closed exact-ID winner after an insert conflict', async () => {
    const fixture = database([
      [],
      [sku],
      [],
      [{ ...existingInterval, status: 'closed', capacityLive: false }],
    ]);
    fixture.returning.mockResolvedValueOnce([]);
    await expect(
      applyStartWithDb(fixture.db, start, id, fingerprint, 60_000)
    ).resolves.toMatchObject({
      kind: 'rejected',
      code: 'interval_closed',
    });
    expect(fixture.update).not.toHaveBeenCalled();
  });

  it('rolls back a failed live reservation renewal instead of acknowledging it', async () => {
    const fixture = database([[existingInterval]]);
    const failure = new Error('renewal unavailable');
    fixture.set.mockImplementation(() => {
      throw failure;
    });
    await expect(applyStartWithDb(fixture.db, start, id, fingerprint, 60_000)).rejects.toBe(
      failure
    );
    expect(fixture.events.at(-1)).toBe('rollback');
  });

  it.each([
    [{ type: 'user', id: start.actor.id }, 'personal', 3],
    [{ type: 'org', id: 'org-1' }, 'organization', 50],
  ] as const)(
    'returns a structured %s rejection without closing or inserting intervals',
    async (subject, accountType, limit) => {
      const fixture = database([[], [sku], [{ start_epoch_ms: 122 }]]);
      vi.mocked(readContainerCapacity).mockResolvedValue([{ subject, live: limit, limit }]);
      await expect(applyStartWithDb(fixture.db, start, id, fingerprint, 1_000)).resolves.toEqual({
        kind: 'rejected',
        code: 'container_limit_reached',
        message: expect.stringMatching(/^container_limit_reached:/),
        accountType,
        limit,
      });
      expect(fixture.insert).not.toHaveBeenCalled();
      expect(fixture.update).not.toHaveBeenCalled();
      expect(fixture.events.at(-1)).toBe('commit');
    }
  );

  it.each(['lock', 'read', 'insert'] as const)(
    'rolls back %s failures without a false rejection',
    async stage => {
      const failure = new Error(`${stage} unavailable`);
      const fixture = database(undefined, stage === 'insert' ? failure : undefined);
      if (stage === 'lock') vi.mocked(lockContainerCapacity).mockRejectedValue(failure);
      if (stage === 'read') vi.mocked(readContainerCapacity).mockRejectedValue(failure);
      await expect(applyStartWithDb(fixture.db, start, id, fingerprint, 1_000)).rejects.toBe(
        failure
      );
      expect(fixture.events.at(-1)).toBe('rollback');
      if (stage === 'lock') expect(fixture.select).not.toHaveBeenCalled();
      if (stage !== 'insert') expect(fixture.insert).not.toHaveBeenCalled();
      expect(fixture.update).not.toHaveBeenCalled();
    }
  );

  it.each([
    { admission: undefined },
    { instanceId: 'crv-1' },
    { metadata: { origin: 'code-review' } },
  ])('preserves starts without admission and Code Reviewer exemptions: %j', async overrides => {
    const fixture = database();
    await expect(
      applyStartWithDb(fixture.db, { ...start, ...overrides }, id, fingerprint, 1_000)
    ).resolves.toEqual({
      kind: 'applied',
      dedup: false,
      billingMode: 'shadow',
    });
    expect(lockContainerCapacity).not.toHaveBeenCalled();
    expect(readContainerCapacity).not.toHaveBeenCalled();
    expect(fixture.insert).toHaveBeenCalledOnce();
  });

  it('preserves SKU rejection without running a capacity read or insertion', async () => {
    const fixture = database([[], []]);
    await expect(
      applyStartWithDb(fixture.db, start, id, fingerprint, 1_000)
    ).resolves.toMatchObject({
      kind: 'rejected',
      code: 'sku_not_found',
    });
    expect(lockContainerCapacity).toHaveBeenCalledOnce();
    expect(readContainerCapacity).not.toHaveBeenCalled();
    expect(fixture.insert).not.toHaveBeenCalled();
  });
});
