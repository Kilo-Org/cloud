import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as DrizzleOrm from 'drizzle-orm';
import { registryInstances, registryProvisionReservations } from '../db/sqlite-schema';
import { sandboxIdFromUserId } from '../auth/sandbox-id';

type Predicate = (row: Record<string, unknown>) => boolean;
type Row = Record<string, unknown>;

const { databaseRows, mockGetActivePersonalInstance, mockHasSubscriptionForInstance } = vi.hoisted(
  () => ({
    databaseRows: {
      instances: [] as Row[],
      reservations: [] as Row[],
    },
    mockGetActivePersonalInstance: vi.fn(),
    mockHasSubscriptionForInstance: vi.fn(),
  })
);

vi.mock('cloudflare:workers', () => ({
  DurableObject: class FakeDurableObject {
    ctx: unknown;
    env: unknown;
    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));
vi.mock('drizzle-orm/durable-sqlite/migrator', () => ({ migrate: vi.fn() }));
vi.mock('drizzle-orm', async importOriginal => {
  const actual = await importOriginal<typeof DrizzleOrm>();
  return {
    ...actual,
    eq:
      (column: { name: string }, value: unknown): Predicate =>
      row =>
        row[column.name] === value,
    isNull:
      (column: { name: string }): Predicate =>
      row =>
        row[column.name] == null,
    and:
      (...predicates: Predicate[]): Predicate =>
      row =>
        predicates.every(predicate => predicate(row)),
    inArray:
      (column: { name: string }, values: unknown[]): Predicate =>
      row =>
        values.includes(row[column.name]),
  };
});
vi.mock('drizzle-orm/durable-sqlite', () => ({
  drizzle: vi.fn(() => createFakeDatabase()),
}));
vi.mock('../db', () => ({
  getWorkerDb: vi.fn(() => ({})),
  getActivePersonalInstance: mockGetActivePersonalInstance,
  hasSubscriptionForInstance: mockHasSubscriptionForInstance,
}));

function rowsForTable(table: unknown): Row[] {
  return table === registryInstances ? databaseRows.instances : databaseRows.reservations;
}

function createFakeDatabase() {
  return {
    select: vi.fn(() => ({
      from: vi.fn((table: unknown) => ({
        all: vi.fn(() => rowsForTable(table)),
        where: vi.fn((predicate: Predicate) => ({
          all: vi.fn(() => rowsForTable(table).filter(predicate)),
          get: vi.fn(() => rowsForTable(table).find(predicate)),
        })),
      })),
    })),
    insert: vi.fn((table: unknown) => ({
      values: vi.fn((values: Row) => ({
        onConflictDoNothing: vi.fn(() => ({
          run: vi.fn(() => {
            const rows = rowsForTable(table);
            if (!rows.some(row => row.instance_id === values.instance_id)) rows.push(values);
          }),
        })),
        onConflictDoUpdate: vi.fn((options: { set: Row }) => ({
          run: vi.fn(() => {
            const rows = rowsForTable(table);
            const existing = rows.find(row => row.instance_id === values.instance_id);
            if (existing) Object.assign(existing, options.set);
            else rows.push(values);
          }),
        })),
        run: vi.fn(() => {
          const rows = rowsForTable(table);
          if (table === registryProvisionReservations) {
            const unresolved = rows.some(
              row =>
                row.assigned_user_id === values.assigned_user_id &&
                ['in_progress', 'failed_requires_reconciliation'].includes(String(row.status))
            );
            if (unresolved) throw new Error('UNIQUE constraint failed');
          }
          rows.push(values);
        }),
      })),
    })),
    update: vi.fn((table: unknown) => ({
      set: vi.fn((patch: Row) => ({
        where: vi.fn((predicate: Predicate) => ({
          run: vi.fn(() => {
            for (const row of rowsForTable(table).filter(predicate)) Object.assign(row, patch);
          }),
        })),
      })),
    })),
  };
}

function createState() {
  const values = new Map<string, unknown>();
  return {
    storage: {
      get: vi.fn(async (key: string) => values.get(key)),
      put: vi.fn(async (key: string, value: unknown) => values.set(key, value)),
      transactionSync: vi.fn((callback: () => unknown) => callback()),
    },
    blockConcurrencyWhile: vi.fn((callback: () => Promise<unknown>) => callback()),
  };
}

import { KiloClawRegistry } from './kiloclaw-registry';

describe('KiloClawRegistry fresh provision reservations', () => {
  beforeEach(() => {
    databaseRows.instances.length = 0;
    databaseRows.reservations.length = 0;
    mockGetActivePersonalInstance.mockReset().mockResolvedValue(null);
    mockHasSubscriptionForInstance.mockReset().mockResolvedValue(false);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('keeps legacy user-keyed rows routable before early-bird backfill completes', async () => {
    mockGetActivePersonalInstance.mockResolvedValue({
      id: 'instance-legacy',
      sandboxId: sandboxIdFromUserId('user-1'),
      orgId: null,
    });
    const registry = new KiloClawRegistry(
      createState() as never,
      { HYPERDRIVE: { connectionString: 'postgresql://fake' } } as never
    );

    expect(await registry.listInstances('user:user-1')).toEqual([
      expect.objectContaining({ instanceId: 'instance-legacy', assignedUserId: 'user-1' }),
    ]);
  });

  it('does not lazily publish an unpaired instance-keyed row or retry it after quarantine', async () => {
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now);
    mockGetActivePersonalInstance.mockResolvedValue({
      id: 'instance-1',
      sandboxId: 'ki_11111111111141118111111111111111',
      orgId: null,
    });
    const registry = new KiloClawRegistry(
      createState() as never,
      { HYPERDRIVE: { connectionString: 'postgresql://fake' } } as never
    );

    expect(await registry.listInstances('user:user-1')).toEqual([]);

    mockHasSubscriptionForInstance.mockResolvedValue(true);
    vi.mocked(Date.now).mockReturnValue(now + 60_001);
    expect(await registry.listInstances('user:user-1')).toEqual([]);
    expect(mockHasSubscriptionForInstance).toHaveBeenCalledTimes(1);
  });

  it('admits one unresolved personal provision and rejects a duplicate', async () => {
    const registry = new KiloClawRegistry(createState() as never, {} as never);

    const first = await registry.beginFreshProvision('user:user-1', 'user-1', 'instance-1', 'do-1');
    const second = await registry.beginFreshProvision(
      'user:user-1',
      'user-1',
      'instance-2',
      'do-2'
    );

    expect(first.outcome).toBe('admitted');
    expect(second).toMatchObject({
      outcome: 'conflict',
      reservation: { instanceId: 'instance-1', status: 'in_progress' },
    });
  });

  it('allows distinct assigned users to provision within one organization registry', async () => {
    const registry = new KiloClawRegistry(createState() as never, {} as never);

    const first = await registry.beginFreshProvision('org:org-1', 'user-1', 'instance-1', 'do-1');
    const second = await registry.beginFreshProvision('org:org-1', 'user-2', 'instance-2', 'do-2');

    expect(first.outcome).toBe('admitted');
    expect(second.outcome).toBe('admitted');
  });

  it('blocks reconciliation-required attempts until an operator releases them', async () => {
    const registry = new KiloClawRegistry(createState() as never, {} as never);
    await registry.beginFreshProvision('user:user-1', 'user-1', 'instance-1', 'do-1');
    await registry.failFreshProvision('user:user-1', 'user-1', 'instance-1', 'provider_failed');

    const blocked = await registry.beginFreshProvision(
      'user:user-1',
      'user-1',
      'instance-2',
      'do-2'
    );
    expect(blocked).toMatchObject({
      outcome: 'conflict',
      reservation: { instanceId: 'instance-1', status: 'failed_requires_reconciliation' },
    });

    await registry.releaseFreshProvision(
      'user:user-1',
      'user-1',
      'instance-1',
      'operator_verified'
    );
    const retry = await registry.beginFreshProvision('user:user-1', 'user-1', 'instance-2', 'do-2');
    expect(retry.outcome).toBe('admitted');
  });

  it('keeps reservations out of routable instance reads until completion', async () => {
    const registry = new KiloClawRegistry(createState() as never, {} as never);
    await registry.beginFreshProvision('user:user-1', 'user-1', 'instance-1', 'do-1');

    expect(await registry.listInstances('user:user-1')).toEqual([]);
    await registry.completeFreshProvision('user:user-1', 'user-1', 'instance-1', 'do-1');
    expect(await registry.listInstances('user:user-1')).toEqual([
      expect.objectContaining({ instanceId: 'instance-1', doKey: 'do-1' }),
    ]);
  });

  it('repairs completion idempotently after a lost finalization acknowledgement', async () => {
    const registry = new KiloClawRegistry(createState() as never, {} as never);
    await registry.beginFreshProvision('user:user-1', 'user-1', 'instance-1', 'do-1');

    await registry.repairCompletedProvision('user:user-1', 'user-1', 'instance-1', 'do-1');
    await registry.repairCompletedProvision('user:user-1', 'user-1', 'instance-1', 'do-1');

    const all = await registry.listAllInstances('user:user-1');
    expect(all.entries).toHaveLength(1);
    expect(all.reservations).toEqual([
      expect.objectContaining({ instanceId: 'instance-1', status: 'completed' }),
    ]);
  });

  it('revives a tombstoned route entry when a reserved canonical provision is repaired', async () => {
    const registry = new KiloClawRegistry(createState() as never, {} as never);
    await registry.beginFreshProvision('user:user-1', 'user-1', 'instance-1', 'do-new');
    databaseRows.instances.push({
      instance_id: 'instance-1',
      do_key: 'do-old',
      assigned_user_id: 'user-old',
      created_at: '2026-05-30T00:00:00.000Z',
      destroyed_at: '2026-05-30T01:00:00.000Z',
    });

    await registry.repairCompletedProvision('user:user-1', 'user-1', 'instance-1', 'do-new');

    expect(await registry.listInstances('user:user-1')).toEqual([
      expect.objectContaining({
        instanceId: 'instance-1',
        doKey: 'do-new',
        assignedUserId: 'user-1',
        destroyedAt: null,
      }),
    ]);
  });

  it('does not resurrect a released reservation during late completion', async () => {
    const registry = new KiloClawRegistry(createState() as never, {} as never);
    await registry.beginFreshProvision('user:user-1', 'user-1', 'instance-1', 'do-1');
    await registry.releaseFreshProvision('user:user-1', 'user-1', 'instance-1', 'destroyed');

    await expect(
      registry.completeFreshProvision('user:user-1', 'user-1', 'instance-1', 'do-1')
    ).rejects.toThrow('Cannot complete a released provision reservation');
    expect(await registry.listInstances('user:user-1')).toEqual([]);
  });

  it('does not resurrect a completed provision after destroy fences delayed repair', async () => {
    const registry = new KiloClawRegistry(createState() as never, {} as never);
    await registry.beginFreshProvision('user:user-1', 'user-1', 'instance-1', 'do-1');
    await registry.completeFreshProvision('user:user-1', 'user-1', 'instance-1', 'do-1');
    await registry.finalizeDestroyedInstance(
      'user:user-1',
      'user-1',
      'instance-1',
      'do-1',
      'destroyed'
    );

    await expect(
      registry.repairCompletedProvision('user:user-1', 'user-1', 'instance-1', 'do-1')
    ).rejects.toThrow('Cannot complete a released provision reservation');
    expect(await registry.listInstances('user:user-1')).toEqual([]);
  });

  it('refuses recovery publication after destroy established a tombstone without reservation', async () => {
    const registry = new KiloClawRegistry(createState() as never, {} as never);
    await registry.finalizeDestroyedInstance(
      'user:user-1',
      'user-1',
      'instance-1',
      'do-1',
      'destroyed'
    );

    expect(
      await registry.publishRecoveredInstance('user:user-1', 'user-1', 'instance-1', 'do-1')
    ).toBe(false);
    expect(await registry.listInstances('user:user-1')).toEqual([]);
  });
});
