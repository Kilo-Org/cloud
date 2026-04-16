import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockGetWorkerDb, mockInsertKiloClawSubscriptionChangeLog } = vi.hoisted(() => ({
  mockGetWorkerDb: vi.fn(),
  mockInsertKiloClawSubscriptionChangeLog: vi.fn(async () => undefined),
}));

vi.mock('@kilocode/db', () => ({
  getWorkerDb: mockGetWorkerDb,
  insertKiloClawSubscriptionChangeLog: mockInsertKiloClawSubscriptionChangeLog,
  kiloclaw_earlybird_purchases: {},
  kiloclaw_instances: {},
  kiloclaw_subscriptions: {},
  organizations: {},
  organization_seats_purchases: {},
}));

import { bootstrapProvisionSubscription } from './bootstrap.js';
import type { BillingWorkerEnv } from './types.js';

type SelectBuilder<T> = PromiseLike<T[]> & {
  from: ReturnType<typeof vi.fn>;
  where: ReturnType<typeof vi.fn>;
  limit: ReturnType<typeof vi.fn>;
  for: ReturnType<typeof vi.fn>;
  then: Promise<T[]>['then'];
};

function createSelectBuilder<T>(rows: T[]): SelectBuilder<T> {
  const promise = Promise.resolve(rows);
  const builder = {
    from: vi.fn(),
    where: vi.fn(),
    limit: vi.fn(),
    for: vi.fn(async () => rows),
    then: promise.then.bind(promise),
  } as SelectBuilder<T>;
  builder.from.mockReturnValue(builder);
  builder.where.mockReturnValue(builder);
  builder.limit.mockReturnValue(builder);
  return builder;
}

function createMockDb(params: {
  selectRows: unknown[][];
  txSelectRows: unknown[][];
  insertReturningRows: unknown[][];
  updateReturningRows: unknown[][];
}) {
  const topLevelSelectQueue = [...params.selectRows];
  const txSelectQueue = [...params.txSelectRows];
  const insertQueue = [...params.insertReturningRows];
  const updateQueue = [...params.updateReturningRows];
  const insertValues: Array<Record<string, unknown>> = [];
  const updateSets: Array<Record<string, unknown>> = [];

  const db = {
    select: vi.fn(() => createSelectBuilder(topLevelSelectQueue.shift() ?? [])),
    transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        select: vi.fn(() => createSelectBuilder(txSelectQueue.shift() ?? [])),
        insert: vi.fn(() => ({
          values: vi.fn((values: Record<string, unknown>) => {
            insertValues.push(values);
            return {
              returning: vi.fn(async () => insertQueue.shift() ?? []),
            };
          }),
        })),
        update: vi.fn(() => ({
          set: vi.fn((values: Record<string, unknown>) => {
            updateSets.push(values);
            return {
              where: vi.fn(() => ({
                returning: vi.fn(async () => updateQueue.shift() ?? []),
              })),
            };
          }),
        })),
      };

      return await callback(tx);
    }),
  };

  return { db, insertValues, updateSets };
}

function createEnv(): BillingWorkerEnv {
  return {
    HYPERDRIVE: { connectionString: 'postgres://test' },
    LIFECYCLE_QUEUE: {
      send: vi.fn(),
    } as unknown as BillingWorkerEnv['LIFECYCLE_QUEUE'],
    KILOCLAW: {
      fetch: vi.fn(),
    },
    KILOCODE_BACKEND_BASE_URL: 'https://app.kilo.ai',
    STRIPE_KILOCLAW_COMMIT_PRICE_ID: 'price_commit',
    STRIPE_KILOCLAW_STANDARD_PRICE_ID: 'price_standard',
    STRIPE_KILOCLAW_STANDARD_INTRO_PRICE_ID: 'price_standard_intro',
    INTERNAL_API_SECRET: 'next-internal-api-secret',
    KILOCLAW_INTERNAL_API_SECRET: 'claw-secret',
  };
}

describe('bootstrapProvisionSubscription successor transfer', () => {
  beforeEach(() => {
    mockGetWorkerDb.mockReset();
    mockInsertKiloClawSubscriptionChangeLog.mockReset();
  });

  it('clears predecessor Stripe ownership before restoring it on successor row', async () => {
    const source = {
      id: 'sub-source',
      user_id: 'user-1',
      instance_id: 'instance-old',
      stripe_subscription_id: 'stripe-live',
      stripe_schedule_id: 'schedule-live',
      transferred_to_subscription_id: null,
      access_origin: null,
      payment_source: 'stripe',
      plan: 'standard',
      scheduled_plan: null,
      scheduled_by: null,
      status: 'active',
      cancel_at_period_end: false,
      pending_conversion: false,
      trial_started_at: null,
      trial_ends_at: null,
      current_period_start: '2026-04-01T00:00:00.000Z',
      current_period_end: '2026-05-01T00:00:00.000Z',
      credit_renewal_at: null,
      commit_ends_at: null,
      past_due_since: null,
      suspended_at: null,
      destruction_deadline: null,
      auto_resume_requested_at: null,
      auto_resume_retry_after: null,
      auto_resume_attempt_count: 0,
      auto_top_up_triggered_for_period: null,
      created_at: '2026-04-01T00:00:00.000Z',
      updated_at: '2026-04-01T00:00:00.000Z',
    };
    const insertedSuccessor = {
      ...source,
      id: 'sub-successor',
      instance_id: 'instance-new',
      stripe_subscription_id: null,
      stripe_schedule_id: null,
      created_at: '2026-04-10T00:00:00.000Z',
      updated_at: '2026-04-10T00:00:00.000Z',
    };
    const predecessorAfter = {
      ...source,
      status: 'canceled',
      transferred_to_subscription_id: insertedSuccessor.id,
      stripe_subscription_id: null,
      stripe_schedule_id: null,
      updated_at: '2026-04-10T00:00:01.000Z',
    };
    const restoredSuccessor = {
      ...insertedSuccessor,
      stripe_subscription_id: source.stripe_subscription_id,
      stripe_schedule_id: source.stripe_schedule_id,
      updated_at: '2026-04-10T00:00:02.000Z',
    };

    const { db, insertValues, updateSets } = createMockDb({
      selectRows: [
        [],
        [source],
        [
          { id: 'instance-old', destroyedAt: '2026-04-09T00:00:00.000Z', organizationId: null },
          { id: 'instance-new', destroyedAt: null, organizationId: null },
        ],
        [],
      ],
      txSelectRows: [[source], [{ id: 'instance-new' }], []],
      insertReturningRows: [[insertedSuccessor]],
      updateReturningRows: [[predecessorAfter], [restoredSuccessor]],
    });
    mockGetWorkerDb.mockReturnValue(db);

    const result = await bootstrapProvisionSubscription(createEnv(), {
      userId: source.user_id,
      instanceId: 'instance-new',
      orgId: null,
    });

    expect(insertValues).toHaveLength(1);
    expect(insertValues[0]).toEqual(
      expect.objectContaining({
        instance_id: 'instance-new',
        stripe_subscription_id: null,
        stripe_schedule_id: null,
      })
    );
    expect(updateSets).toHaveLength(2);
    expect(updateSets[0]).toEqual(
      expect.objectContaining({
        transferred_to_subscription_id: insertedSuccessor.id,
        payment_source: 'credits',
        stripe_subscription_id: null,
        stripe_schedule_id: null,
      })
    );
    expect(updateSets[1]).toEqual(
      expect.objectContaining({
        stripe_subscription_id: source.stripe_subscription_id,
        stripe_schedule_id: source.stripe_schedule_id,
      })
    );
    expect(result).toEqual(restoredSuccessor);
    expect(mockInsertKiloClawSubscriptionChangeLog).toHaveBeenCalledTimes(2);
    expect(mockInsertKiloClawSubscriptionChangeLog).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      expect.objectContaining({
        subscriptionId: restoredSuccessor.id,
        after: restoredSuccessor,
      })
    );
  });

  it('adopts detached paid personal row onto new provisioned instance', async () => {
    const source = {
      id: 'sub-detached',
      user_id: 'user-1',
      instance_id: null,
      stripe_subscription_id: 'stripe-detached',
      stripe_schedule_id: null,
      transferred_to_subscription_id: null,
      access_origin: null,
      payment_source: 'stripe',
      plan: 'standard',
      scheduled_plan: null,
      scheduled_by: null,
      status: 'active',
      cancel_at_period_end: false,
      pending_conversion: false,
      trial_started_at: null,
      trial_ends_at: null,
      current_period_start: '2026-04-01T00:00:00.000Z',
      current_period_end: '2026-05-01T00:00:00.000Z',
      credit_renewal_at: null,
      commit_ends_at: null,
      past_due_since: null,
      suspended_at: null,
      destruction_deadline: null,
      auto_resume_requested_at: null,
      auto_resume_retry_after: null,
      auto_resume_attempt_count: 0,
      auto_top_up_triggered_for_period: null,
      created_at: '2026-04-01T00:00:00.000Z',
      updated_at: '2026-04-01T00:00:00.000Z',
    };
    const insertedSuccessor = {
      ...source,
      id: 'sub-attached',
      instance_id: 'instance-new',
      stripe_subscription_id: null,
      created_at: '2026-04-10T00:00:00.000Z',
      updated_at: '2026-04-10T00:00:00.000Z',
    };
    const predecessorAfter = {
      ...source,
      status: 'canceled',
      transferred_to_subscription_id: insertedSuccessor.id,
      stripe_subscription_id: null,
      updated_at: '2026-04-10T00:00:01.000Z',
    };
    const restoredSuccessor = {
      ...insertedSuccessor,
      stripe_subscription_id: source.stripe_subscription_id,
      updated_at: '2026-04-10T00:00:02.000Z',
    };

    const { db, insertValues, updateSets } = createMockDb({
      selectRows: [
        [],
        [source],
        [{ id: 'instance-new', destroyedAt: null, organizationId: null }],
        [],
      ],
      txSelectRows: [[source], [{ id: 'instance-new' }], []],
      insertReturningRows: [[insertedSuccessor]],
      updateReturningRows: [[predecessorAfter], [restoredSuccessor]],
    });
    mockGetWorkerDb.mockReturnValue(db);

    const result = await bootstrapProvisionSubscription(createEnv(), {
      userId: source.user_id,
      instanceId: 'instance-new',
      orgId: null,
    });

    expect(insertValues).toHaveLength(1);
    expect(insertValues[0]).toEqual(
      expect.objectContaining({
        instance_id: 'instance-new',
        stripe_subscription_id: null,
      })
    );
    expect(updateSets).toHaveLength(2);
    expect(updateSets[0]).toEqual(
      expect.objectContaining({
        transferred_to_subscription_id: insertedSuccessor.id,
        stripe_subscription_id: null,
      })
    );
    expect(updateSets[1]).toEqual(
      expect.objectContaining({
        stripe_subscription_id: source.stripe_subscription_id,
      })
    );
    expect(result).toEqual(restoredSuccessor);
  });

  it('ignores historical destroyed canceled rows when choosing destroyed successor source', async () => {
    const historicalRow = {
      id: 'sub-historical',
      user_id: 'user-1',
      instance_id: 'instance-older',
      stripe_subscription_id: 'stripe-old',
      stripe_schedule_id: null,
      transferred_to_subscription_id: null,
      access_origin: null,
      payment_source: 'stripe',
      plan: 'standard',
      scheduled_plan: null,
      scheduled_by: null,
      status: 'canceled',
      cancel_at_period_end: false,
      pending_conversion: false,
      trial_started_at: null,
      trial_ends_at: null,
      current_period_start: '2026-02-01T00:00:00.000Z',
      current_period_end: '2026-03-01T00:00:00.000Z',
      credit_renewal_at: null,
      commit_ends_at: null,
      past_due_since: null,
      suspended_at: null,
      destruction_deadline: null,
      auto_resume_requested_at: null,
      auto_resume_retry_after: null,
      auto_resume_attempt_count: 0,
      auto_top_up_triggered_for_period: null,
      created_at: '2026-02-01T00:00:00.000Z',
      updated_at: '2026-03-01T00:00:00.000Z',
    };
    const source = {
      ...historicalRow,
      id: 'sub-current-destroyed',
      instance_id: 'instance-old',
      stripe_subscription_id: 'stripe-live',
      status: 'active',
      current_period_start: '2026-04-01T00:00:00.000Z',
      current_period_end: '2026-05-01T00:00:00.000Z',
      created_at: '2026-04-01T00:00:00.000Z',
      updated_at: '2026-04-10T00:00:00.000Z',
    };
    const insertedSuccessor = {
      ...source,
      id: 'sub-successor-new',
      instance_id: 'instance-new',
      stripe_subscription_id: null,
      created_at: '2026-04-11T00:00:00.000Z',
      updated_at: '2026-04-11T00:00:00.000Z',
    };
    const predecessorAfter = {
      ...source,
      status: 'canceled',
      transferred_to_subscription_id: insertedSuccessor.id,
      stripe_subscription_id: null,
      updated_at: '2026-04-11T00:00:01.000Z',
    };
    const restoredSuccessor = {
      ...insertedSuccessor,
      stripe_subscription_id: source.stripe_subscription_id,
      updated_at: '2026-04-11T00:00:02.000Z',
    };

    const { db, insertValues, updateSets } = createMockDb({
      selectRows: [
        [],
        [historicalRow, source],
        [
          { id: 'instance-older', destroyedAt: '2026-03-05T00:00:00.000Z', organizationId: null },
          { id: 'instance-old', destroyedAt: '2026-04-10T00:00:00.000Z', organizationId: null },
          { id: 'instance-new', destroyedAt: null, organizationId: null },
        ],
        [],
      ],
      txSelectRows: [[source], [{ id: 'instance-new' }], []],
      insertReturningRows: [[insertedSuccessor]],
      updateReturningRows: [[predecessorAfter], [restoredSuccessor]],
    });
    mockGetWorkerDb.mockReturnValue(db);

    const result = await bootstrapProvisionSubscription(createEnv(), {
      userId: source.user_id,
      instanceId: 'instance-new',
      orgId: null,
    });

    expect(insertValues).toHaveLength(1);
    expect(updateSets[0]).toEqual(
      expect.objectContaining({
        transferred_to_subscription_id: insertedSuccessor.id,
      })
    );
    expect(result).toEqual(restoredSuccessor);
  });

  it('fails closed when multiple destroyed current access-granting rows remain', async () => {
    const destroyedA = {
      id: 'sub-destroyed-a',
      user_id: 'user-1',
      instance_id: 'instance-old-a',
      stripe_subscription_id: 'stripe-a',
      stripe_schedule_id: null,
      transferred_to_subscription_id: null,
      access_origin: null,
      payment_source: 'stripe',
      plan: 'standard',
      scheduled_plan: null,
      scheduled_by: null,
      status: 'active',
      cancel_at_period_end: false,
      pending_conversion: false,
      trial_started_at: null,
      trial_ends_at: null,
      current_period_start: '2026-04-01T00:00:00.000Z',
      current_period_end: '2026-05-01T00:00:00.000Z',
      credit_renewal_at: null,
      commit_ends_at: null,
      past_due_since: null,
      suspended_at: null,
      destruction_deadline: null,
      auto_resume_requested_at: null,
      auto_resume_retry_after: null,
      auto_resume_attempt_count: 0,
      auto_top_up_triggered_for_period: null,
      created_at: '2026-04-01T00:00:00.000Z',
      updated_at: '2026-04-05T00:00:00.000Z',
    };
    const destroyedB = {
      ...destroyedA,
      id: 'sub-destroyed-b',
      instance_id: 'instance-old-b',
      stripe_subscription_id: 'stripe-b',
      current_period_start: '2026-04-10T00:00:00.000Z',
      current_period_end: '2026-05-10T00:00:00.000Z',
      created_at: '2026-04-10T00:00:00.000Z',
      updated_at: '2026-04-11T00:00:00.000Z',
    };

    const { db, insertValues, updateSets } = createMockDb({
      selectRows: [
        [],
        [destroyedA, destroyedB],
        [
          { id: 'instance-old-a', destroyedAt: '2026-04-06T00:00:00.000Z', organizationId: null },
          { id: 'instance-old-b', destroyedAt: '2026-04-12T00:00:00.000Z', organizationId: null },
          { id: 'instance-new', destroyedAt: null, organizationId: null },
        ],
        [],
      ],
      txSelectRows: [],
      insertReturningRows: [],
      updateReturningRows: [],
    });
    mockGetWorkerDb.mockReturnValue(db);

    await expect(
      bootstrapProvisionSubscription(createEnv(), {
        userId: destroyedA.user_id,
        instanceId: 'instance-new',
        orgId: null,
      })
    ).rejects.toThrow('Multiple current personal subscription rows found during bootstrap');

    expect(insertValues).toHaveLength(0);
    expect(updateSets).toHaveLength(0);
  });

  it('ignores subscription rows whose anchor instance record is missing', async () => {
    const orphanedRow = {
      id: 'sub-missing-instance',
      user_id: 'user-1',
      instance_id: 'instance-missing',
      stripe_subscription_id: 'stripe-missing',
      stripe_schedule_id: null,
      transferred_to_subscription_id: null,
      access_origin: null,
      payment_source: 'stripe',
      plan: 'standard',
      scheduled_plan: null,
      scheduled_by: null,
      status: 'active',
      cancel_at_period_end: false,
      pending_conversion: false,
      trial_started_at: null,
      trial_ends_at: null,
      current_period_start: '2026-04-01T00:00:00.000Z',
      current_period_end: '2026-05-01T00:00:00.000Z',
      credit_renewal_at: null,
      commit_ends_at: null,
      past_due_since: null,
      suspended_at: null,
      destruction_deadline: null,
      auto_resume_requested_at: null,
      auto_resume_retry_after: null,
      auto_resume_attempt_count: 0,
      auto_top_up_triggered_for_period: null,
      created_at: '2026-04-01T00:00:00.000Z',
      updated_at: '2026-04-05T00:00:00.000Z',
    };
    const source = {
      ...orphanedRow,
      id: 'sub-current-destroyed',
      instance_id: 'instance-old',
      stripe_subscription_id: 'stripe-live',
      updated_at: '2026-04-10T00:00:00.000Z',
    };
    const insertedSuccessor = {
      ...source,
      id: 'sub-successor-new',
      instance_id: 'instance-new',
      stripe_subscription_id: null,
      created_at: '2026-04-11T00:00:00.000Z',
      updated_at: '2026-04-11T00:00:00.000Z',
    };
    const predecessorAfter = {
      ...source,
      status: 'canceled',
      transferred_to_subscription_id: insertedSuccessor.id,
      payment_source: 'credits',
      stripe_subscription_id: null,
      updated_at: '2026-04-11T00:00:01.000Z',
    };
    const restoredSuccessor = {
      ...insertedSuccessor,
      stripe_subscription_id: source.stripe_subscription_id,
      updated_at: '2026-04-11T00:00:02.000Z',
    };

    const { db, insertValues, updateSets } = createMockDb({
      selectRows: [
        [],
        [orphanedRow, source],
        [
          { id: 'instance-old', destroyedAt: '2026-04-10T00:00:00.000Z', organizationId: null },
          { id: 'instance-new', destroyedAt: null, organizationId: null },
        ],
        [],
      ],
      txSelectRows: [[source], [{ id: 'instance-new' }], []],
      insertReturningRows: [[insertedSuccessor]],
      updateReturningRows: [[predecessorAfter], [restoredSuccessor]],
    });
    mockGetWorkerDb.mockReturnValue(db);

    const result = await bootstrapProvisionSubscription(createEnv(), {
      userId: source.user_id,
      instanceId: 'instance-new',
      orgId: null,
    });

    expect(insertValues).toHaveLength(1);
    expect(updateSets[0]).toEqual(
      expect.objectContaining({
        transferred_to_subscription_id: insertedSuccessor.id,
      })
    );
    expect(result).toEqual(restoredSuccessor);
  });
});

type FreshInsertDbParams = {
  selectRows: unknown[][];
  insertFirstReturningRows: unknown[];
  reselectAfterConflictRows: unknown[];
};

function createFreshInsertSelectBuilder<T>(rows: T[]) {
  const promise = Promise.resolve(rows);
  const builder: {
    from: ReturnType<typeof vi.fn>;
    where: ReturnType<typeof vi.fn>;
    orderBy: ReturnType<typeof vi.fn>;
    limit: ReturnType<typeof vi.fn>;
    then: Promise<T[]>['then'];
  } = {
    from: vi.fn(),
    where: vi.fn(),
    orderBy: vi.fn(),
    limit: vi.fn(),
    then: promise.then.bind(promise),
  };
  builder.from.mockReturnValue(builder);
  builder.where.mockReturnValue(builder);
  builder.orderBy.mockReturnValue(builder);
  builder.limit.mockReturnValue(builder);
  return builder;
}

function createFreshInsertDb(params: FreshInsertDbParams) {
  const selectQueue = [...params.selectRows];
  const insertValues: Array<Record<string, unknown>> = [];
  const onConflictCalls: Array<unknown> = [];
  let firstInsert = true;

  const db = {
    select: vi.fn(() => createFreshInsertSelectBuilder(selectQueue.shift() ?? [])),
    insert: vi.fn(() => ({
      values: vi.fn((values: Record<string, unknown>) => {
        insertValues.push(values);
        return {
          onConflictDoNothing: vi.fn((target: unknown) => {
            onConflictCalls.push(target);
            return {
              returning: vi.fn(async () => {
                if (firstInsert) {
                  firstInsert = false;
                  return params.insertFirstReturningRows;
                }
                return [];
              }),
            };
          }),
        };
      }),
    })),
  };

  return { db, insertValues, onConflictCalls };
}

describe('bootstrapProvisionSubscription concurrent insert race', () => {
  beforeEach(() => {
    mockGetWorkerDb.mockReset();
    mockInsertKiloClawSubscriptionChangeLog.mockReset();
  });

  it('personal fresh-insert: loser of insert race returns winner row instead of throwing', async () => {
    const winnerRow = {
      id: 'sub-winner',
      user_id: 'user-1',
      instance_id: 'instance-new',
      plan: 'trial',
      status: 'trialing',
      access_origin: null,
      payment_source: null,
      cancel_at_period_end: false,
      trial_started_at: '2026-04-16T00:00:00.000Z',
      trial_ends_at: '2026-04-23T00:00:00.000Z',
      stripe_subscription_id: null,
      stripe_schedule_id: null,
      transferred_to_subscription_id: null,
      scheduled_plan: null,
      scheduled_by: null,
      pending_conversion: false,
      current_period_start: null,
      current_period_end: null,
      credit_renewal_at: null,
      commit_ends_at: null,
      past_due_since: null,
      suspended_at: null,
      destruction_deadline: null,
      auto_resume_requested_at: null,
      auto_resume_retry_after: null,
      auto_resume_attempt_count: 0,
      auto_top_up_triggered_for_period: null,
      created_at: '2026-04-16T00:00:00.000Z',
      updated_at: '2026-04-16T00:00:00.000Z',
    };
    const { db, insertValues } = createFreshInsertDb({
      selectRows: [
        [], // existingForInstance (none seen yet — TOCTOU window)
        [], // subscriptions for user
        [], // instances for user
        [], // earlybirdPurchase
        [winnerRow], // reselect after conflict
      ],
      insertFirstReturningRows: [], // onConflictDoNothing swallowed our insert
      reselectAfterConflictRows: [winnerRow],
    });
    mockGetWorkerDb.mockReturnValue(db);

    const result = await bootstrapProvisionSubscription(createEnv(), {
      userId: 'user-1',
      instanceId: 'instance-new',
      orgId: null,
    });

    expect(result).toEqual(winnerRow);
    expect(insertValues).toHaveLength(1);
    expect(insertValues[0]).toEqual(
      expect.objectContaining({
        instance_id: 'instance-new',
      })
    );
    // Race loser must not write a change-log row (winner already logged it).
    expect(mockInsertKiloClawSubscriptionChangeLog).not.toHaveBeenCalled();
  });

  it('org fresh-insert: loser of insert race returns winner row instead of throwing', async () => {
    const winnerRow = {
      id: 'sub-org-winner',
      user_id: 'user-1',
      instance_id: 'instance-new',
      plan: 'standard',
      status: 'active',
      access_origin: null,
      payment_source: 'credits',
      cancel_at_period_end: false,
      trial_started_at: null,
      trial_ends_at: null,
      stripe_subscription_id: null,
      stripe_schedule_id: null,
      transferred_to_subscription_id: null,
      scheduled_plan: null,
      scheduled_by: null,
      pending_conversion: false,
      current_period_start: null,
      current_period_end: null,
      credit_renewal_at: null,
      commit_ends_at: null,
      past_due_since: null,
      suspended_at: null,
      destruction_deadline: null,
      auto_resume_requested_at: null,
      auto_resume_retry_after: null,
      auto_resume_attempt_count: 0,
      auto_top_up_triggered_for_period: null,
      created_at: '2026-04-16T00:00:00.000Z',
      updated_at: '2026-04-16T00:00:00.000Z',
    };
    const { db, insertValues, onConflictCalls } = createFreshInsertDb({
      selectRows: [
        [], // existing subscription for instance (none yet — TOCTOU window)
        [
          {
            createdAt: '2026-04-01T00:00:00.000Z',
            freeTrialEndAt: null,
            requireSeats: false,
            settings: {},
          },
        ], // organization row
        [], // latestSeatPurchase
        [winnerRow], // reselect after conflict
      ],
      insertFirstReturningRows: [], // onConflictDoNothing swallowed our insert
      reselectAfterConflictRows: [winnerRow],
    });
    mockGetWorkerDb.mockReturnValue(db);

    const result = await bootstrapProvisionSubscription(createEnv(), {
      userId: 'user-1',
      instanceId: 'instance-new',
      orgId: '22222222-2222-4222-8222-222222222222',
    });

    expect(result).toEqual(winnerRow);
    expect(insertValues).toHaveLength(1);
    expect(onConflictCalls).toHaveLength(1);
    expect(mockInsertKiloClawSubscriptionChangeLog).not.toHaveBeenCalled();
  });
});
