import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import {
  collapseOrphanPersonalSubscriptionsOnDestroy,
  markInstanceDestroyedWithPersonalSubscriptionCollapse,
  PersonalSubscriptionDestroyConflictError,
} from '@kilocode/db';
import {
  kiloclaw_instances,
  kiloclaw_subscription_change_log,
  kiloclaw_subscriptions,
} from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';

import { listCurrentPersonalSubscriptionRows } from '@/lib/kiloclaw/current-personal-subscription';
import { cleanupDbForTest, db } from '@/lib/drizzle';
import { insertTestUser } from '@/tests/helpers/user.helper';

const TEST_ACTOR = {
  actorType: 'system',
  actorId: 'personal-subscription-destroy-collapse-test',
} as const;

async function insertPersonalInstance(params: {
  createdAt: string;
  destroyedAt?: string;
  id: string;
  userId: string;
}) {
  await db.insert(kiloclaw_instances).values({
    id: params.id,
    user_id: params.userId,
    sandbox_id: `ki_${params.id.replaceAll('-', '')}`,
    created_at: params.createdAt,
    destroyed_at: params.destroyedAt ?? null,
  });
}

async function insertPersonalSubscription(params: {
  createdAt: string;
  id: string;
  instanceId: string;
  plan: 'standard' | 'trial';
  status: 'active' | 'canceled';
  transferredToSubscriptionId?: string | null;
  userId: string;
}) {
  await db.insert(kiloclaw_subscriptions).values({
    id: params.id,
    user_id: params.userId,
    instance_id: params.instanceId,
    plan: params.plan,
    status: params.status,
    payment_source: 'credits',
    cancel_at_period_end: false,
    transferred_to_subscription_id: params.transferredToSubscriptionId ?? null,
    created_at: params.createdAt,
    updated_at: params.createdAt,
  });
}

describe('personal subscription destroy collapse', () => {
  beforeEach(async () => {
    await cleanupDbForTest();
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('collapses older personal rows when last alive instance is destroyed', async () => {
    const user = await insertTestUser({
      google_user_email: 'destroy-collapse@example.com',
    });

    const instanceA = crypto.randomUUID();
    const instanceB = crypto.randomUUID();
    const instanceC = crypto.randomUUID();
    const subscriptionA = crypto.randomUUID();
    const subscriptionB = crypto.randomUUID();
    const subscriptionC = crypto.randomUUID();

    await insertPersonalInstance({
      id: instanceA,
      userId: user.id,
      createdAt: '2026-03-01T00:00:00.000Z',
      destroyedAt: '2026-03-10T00:00:00.000Z',
    });
    await insertPersonalInstance({
      id: instanceB,
      userId: user.id,
      createdAt: '2026-03-15T00:00:00.000Z',
      destroyedAt: '2026-03-20T00:00:00.000Z',
    });
    await insertPersonalInstance({
      id: instanceC,
      userId: user.id,
      createdAt: '2026-04-01T00:00:00.000Z',
    });

    await insertPersonalSubscription({
      id: subscriptionA,
      userId: user.id,
      instanceId: instanceA,
      createdAt: '2026-03-01T00:00:00.000Z',
      plan: 'trial',
      status: 'canceled',
    });
    await insertPersonalSubscription({
      id: subscriptionB,
      userId: user.id,
      instanceId: instanceB,
      createdAt: '2026-03-15T00:00:00.000Z',
      plan: 'standard',
      status: 'canceled',
    });
    await insertPersonalSubscription({
      id: subscriptionC,
      userId: user.id,
      instanceId: instanceC,
      createdAt: '2026-04-01T00:00:00.000Z',
      plan: 'standard',
      status: 'active',
    });

    await db.transaction(async tx => {
      await markInstanceDestroyedWithPersonalSubscriptionCollapse({
        actor: TEST_ACTOR,
        executor: tx,
        instanceId: instanceC,
        reason: 'destroy_path_inline_collapse',
        userId: user.id,
      });
    });

    const currentRows = await listCurrentPersonalSubscriptionRows({ userId: user.id });
    expect(currentRows).toHaveLength(1);
    expect(currentRows[0]?.subscription.id).toBe(subscriptionC);

    const subscriptions = await db
      .select()
      .from(kiloclaw_subscriptions)
      .where(eq(kiloclaw_subscriptions.user_id, user.id))
      .orderBy(kiloclaw_subscriptions.created_at);

    expect(subscriptions.map(subscription => subscription.transferred_to_subscription_id)).toEqual([
      subscriptionB,
      subscriptionC,
      null,
    ]);

    const changeLogs = await db
      .select()
      .from(kiloclaw_subscription_change_log)
      .where(eq(kiloclaw_subscription_change_log.actor_id, TEST_ACTOR.actorId))
      .orderBy(kiloclaw_subscription_change_log.created_at);

    expect(changeLogs).toHaveLength(2);
    expect(changeLogs.every(log => log.reason === 'destroy_path_inline_collapse')).toBe(true);
    expect(changeLogs.map(log => log.subscription_id).sort()).toEqual(
      [subscriptionA, subscriptionB].sort()
    );
  });

  it('splices existing chain around orphan and is idempotent on rerun', async () => {
    const user = await insertTestUser({
      google_user_email: 'destroy-splice@example.com',
    });

    const instanceA = crypto.randomUUID();
    const instanceB = crypto.randomUUID();
    const instanceC = crypto.randomUUID();
    const subscriptionA = crypto.randomUUID();
    const subscriptionB = crypto.randomUUID();
    const subscriptionC = crypto.randomUUID();

    await insertPersonalInstance({
      id: instanceA,
      userId: user.id,
      createdAt: '2026-03-01T00:00:00.000Z',
      destroyedAt: '2026-03-02T00:00:00.000Z',
    });
    await insertPersonalInstance({
      id: instanceB,
      userId: user.id,
      createdAt: '2026-03-05T00:00:00.000Z',
      destroyedAt: '2026-03-06T00:00:00.000Z',
    });
    await insertPersonalInstance({
      id: instanceC,
      userId: user.id,
      createdAt: '2026-03-10T00:00:00.000Z',
    });

    await insertPersonalSubscription({
      id: subscriptionC,
      userId: user.id,
      instanceId: instanceC,
      createdAt: '2026-03-10T00:00:00.000Z',
      plan: 'standard',
      status: 'active',
    });
    await insertPersonalSubscription({
      id: subscriptionA,
      userId: user.id,
      instanceId: instanceA,
      createdAt: '2026-03-01T00:00:00.000Z',
      plan: 'trial',
      status: 'canceled',
      transferredToSubscriptionId: subscriptionC,
    });
    await insertPersonalSubscription({
      id: subscriptionB,
      userId: user.id,
      instanceId: instanceB,
      createdAt: '2026-03-05T00:00:00.000Z',
      plan: 'standard',
      status: 'canceled',
    });

    await db.transaction(async tx => {
      await markInstanceDestroyedWithPersonalSubscriptionCollapse({
        actor: TEST_ACTOR,
        executor: tx,
        instanceId: instanceC,
        reason: 'destroy_path_inline_collapse',
        userId: user.id,
      });
    });

    const afterFirstRun = await db
      .select()
      .from(kiloclaw_subscriptions)
      .where(eq(kiloclaw_subscriptions.user_id, user.id))
      .orderBy(kiloclaw_subscriptions.created_at);

    expect(afterFirstRun.map(subscription => subscription.transferred_to_subscription_id)).toEqual([
      subscriptionB,
      subscriptionC,
      null,
    ]);

    const result = await db.transaction(async tx => {
      return await collapseOrphanPersonalSubscriptionsOnDestroy({
        actor: TEST_ACTOR,
        destroyedInstanceId: instanceC,
        executor: tx,
        reason: 'destroy_path_inline_collapse',
        userId: user.id,
      });
    });

    expect(result.updatedSubscriptionIds).toHaveLength(0);

    const logs = await db
      .select()
      .from(kiloclaw_subscription_change_log)
      .where(eq(kiloclaw_subscription_change_log.actor_id, TEST_ACTOR.actorId));

    expect(logs).toHaveLength(2);
  });

  it('logs and continues when collapse change log write fails outside transaction', async () => {
    const user = await insertTestUser({
      google_user_email: 'destroy-collapse-best-effort@example.com',
    });

    const instanceA = crypto.randomUUID();
    const instanceB = crypto.randomUUID();
    const instanceC = crypto.randomUUID();
    const subscriptionA = crypto.randomUUID();
    const subscriptionB = crypto.randomUUID();
    const subscriptionC = crypto.randomUUID();

    await insertPersonalInstance({
      id: instanceA,
      userId: user.id,
      createdAt: '2026-03-01T00:00:00.000Z',
      destroyedAt: '2026-03-10T00:00:00.000Z',
    });
    await insertPersonalInstance({
      id: instanceB,
      userId: user.id,
      createdAt: '2026-03-15T00:00:00.000Z',
      destroyedAt: '2026-03-20T00:00:00.000Z',
    });
    await insertPersonalInstance({
      id: instanceC,
      userId: user.id,
      createdAt: '2026-04-01T00:00:00.000Z',
    });

    await insertPersonalSubscription({
      id: subscriptionA,
      userId: user.id,
      instanceId: instanceA,
      createdAt: '2026-03-01T00:00:00.000Z',
      plan: 'trial',
      status: 'canceled',
    });
    await insertPersonalSubscription({
      id: subscriptionB,
      userId: user.id,
      instanceId: instanceB,
      createdAt: '2026-03-15T00:00:00.000Z',
      plan: 'standard',
      status: 'canceled',
    });
    await insertPersonalSubscription({
      id: subscriptionC,
      userId: user.id,
      instanceId: instanceC,
      createdAt: '2026-04-01T00:00:00.000Z',
      plan: 'standard',
      status: 'active',
    });

    const changeLogFailure = new Error('change-log insert failed');
    const onChangeLogFailure =
      jest.fn<
        (context: {
          error: unknown;
          reason: string;
          subscriptionId: string;
          userId: string;
        }) => void
      >();
    const executor = Object.assign(Object.create(db), {
      insert: ((table: typeof kiloclaw_subscription_change_log) => {
        if (table === kiloclaw_subscription_change_log) {
          return {
            values: async () => {
              throw changeLogFailure;
            },
          };
        }
        return db.insert(table);
      }) as typeof db.insert,
    });

    const destroyed = await markInstanceDestroyedWithPersonalSubscriptionCollapse({
      actor: TEST_ACTOR,
      changeLogFailurePolicy: 'log',
      executor,
      instanceId: instanceC,
      onChangeLogFailure,
      reason: 'destroy_path_inline_collapse',
      userId: user.id,
    });

    expect(destroyed?.id).toBe(instanceC);
    expect(onChangeLogFailure).toHaveBeenCalledTimes(2);
    expect(onChangeLogFailure).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        error: changeLogFailure,
        reason: 'destroy_path_inline_collapse',
        subscriptionId: subscriptionA,
        userId: user.id,
      })
    );
    expect(onChangeLogFailure).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        error: changeLogFailure,
        reason: 'destroy_path_inline_collapse',
        subscriptionId: subscriptionB,
        userId: user.id,
      })
    );

    const subscriptions = await db
      .select()
      .from(kiloclaw_subscriptions)
      .where(eq(kiloclaw_subscriptions.user_id, user.id))
      .orderBy(kiloclaw_subscriptions.created_at);

    expect(subscriptions.map(subscription => subscription.transferred_to_subscription_id)).toEqual([
      subscriptionB,
      subscriptionC,
      null,
    ]);

    const logs = await db
      .select()
      .from(kiloclaw_subscription_change_log)
      .where(eq(kiloclaw_subscription_change_log.actor_id, TEST_ACTOR.actorId));

    expect(logs).toHaveLength(0);
  });

  it('refuses collapse when multiple alive current personal rows exist', async () => {
    const user = await insertTestUser({
      google_user_email: 'destroy-refuse-multi-alive@example.com',
    });

    const instanceA = crypto.randomUUID();
    const instanceB = crypto.randomUUID();
    const subscriptionA = crypto.randomUUID();
    const subscriptionB = crypto.randomUUID();

    await insertPersonalInstance({
      id: instanceA,
      userId: user.id,
      createdAt: '2026-03-01T00:00:00.000Z',
    });
    await insertPersonalInstance({
      id: instanceB,
      userId: user.id,
      createdAt: '2026-03-02T00:00:00.000Z',
    });

    await insertPersonalSubscription({
      id: subscriptionA,
      userId: user.id,
      instanceId: instanceA,
      createdAt: '2026-03-01T00:00:00.000Z',
      plan: 'standard',
      status: 'active',
    });
    await insertPersonalSubscription({
      id: subscriptionB,
      userId: user.id,
      instanceId: instanceB,
      createdAt: '2026-03-02T00:00:00.000Z',
      plan: 'standard',
      status: 'active',
    });

    await expect(
      db.transaction(async tx => {
        await markInstanceDestroyedWithPersonalSubscriptionCollapse({
          actor: TEST_ACTOR,
          executor: tx,
          instanceId: instanceB,
          reason: 'destroy_path_inline_collapse',
          userId: user.id,
        });
      })
    ).rejects.toThrow(PersonalSubscriptionDestroyConflictError);

    const instances = await db
      .select()
      .from(kiloclaw_instances)
      .where(eq(kiloclaw_instances.user_id, user.id))
      .orderBy(kiloclaw_instances.created_at);

    expect(instances.every(instance => instance.destroyed_at === null)).toBe(true);

    const subscriptions = await db
      .select()
      .from(kiloclaw_subscriptions)
      .where(eq(kiloclaw_subscriptions.user_id, user.id))
      .orderBy(kiloclaw_subscriptions.created_at);

    expect(
      subscriptions.every(subscription => subscription.transferred_to_subscription_id === null)
    ).toBe(true);
  });
});
