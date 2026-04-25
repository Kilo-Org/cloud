import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import {
  collapseOrphanPersonalSubscriptionsOnDestroy,
  FundedRowDemotionRefusedError,
  markInstanceDestroyedWithPersonalSubscriptionCollapse,
  PersonalSubscriptionDestroyConflictError,
} from '@kilocode/db';
import {
  kiloclaw_instances,
  kiloclaw_subscription_change_log,
  kiloclaw_subscriptions,
} from '@kilocode/db/schema';
import { eq, inArray } from 'drizzle-orm';

import { listCurrentPersonalSubscriptionRows } from '@/lib/kiloclaw/current-personal-subscription';
import { cleanupDbForTest, db } from '@/lib/drizzle';
import { insertTestUser } from '@/tests/helpers/user.helper';

const TEST_ACTOR = {
  actorType: 'system',
  actorId: 'personal-subscription-destroy-collapse-test',
} as const;

const DESTROY_REASON = 'destroy_path_inline_collapse';
const CANCEL_SINGLE_REASON = 'destroy_path_cancel_single_current_access_row';

type PersonalPlan = 'standard' | 'trial' | 'commit';
type PersonalStatus = 'active' | 'canceled' | 'trialing' | 'past_due';

type ExpectedChangeLogEntry = {
  subscriptionId: string;
  action: 'reassigned' | 'canceled';
  reason: string;
  beforeTransferredTo: string | null;
  afterTransferredTo: string | null;
  beforePlan: PersonalPlan;
  afterPlan?: PersonalPlan;
  beforeStatus: PersonalStatus;
  afterStatus?: PersonalStatus;
  beforeStripeSubscriptionId?: string | null;
  afterStripeSubscriptionId?: string | null;
  beforeStripeScheduleId?: string | null;
  afterStripeScheduleId?: string | null;
};

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
  plan: PersonalPlan;
  paymentSource?: 'credits' | 'stripe' | null;
  status: PersonalStatus;
  stripeScheduleId?: string | null;
  stripeSubscriptionId?: string | null;
  suspendedAt?: string | null;
  transferredToSubscriptionId?: string | null;
  trialEndsAt?: string | null;
  trialStartedAt?: string | null;
  userId: string;
}) {
  await db.insert(kiloclaw_subscriptions).values({
    id: params.id,
    user_id: params.userId,
    instance_id: params.instanceId,
    plan: params.plan,
    status: params.status,
    payment_source: params.paymentSource ?? (params.plan === 'trial' ? null : 'credits'),
    stripe_subscription_id: params.stripeSubscriptionId ?? null,
    stripe_schedule_id: params.stripeScheduleId ?? null,
    suspended_at: params.suspendedAt ?? null,
    trial_started_at: params.trialStartedAt ?? null,
    trial_ends_at: params.trialEndsAt ?? null,
    cancel_at_period_end: false,
    transferred_to_subscription_id: params.transferredToSubscriptionId ?? null,
    created_at: params.createdAt,
    updated_at: params.createdAt,
  });
}

async function listUserSubscriptions(userId: string) {
  return await db
    .select()
    .from(kiloclaw_subscriptions)
    .where(eq(kiloclaw_subscriptions.user_id, userId))
    .orderBy(kiloclaw_subscriptions.created_at, kiloclaw_subscriptions.id);
}

async function listChangeLogsForSubscriptions(subscriptionIds: string[]) {
  if (subscriptionIds.length === 0) {
    return [];
  }

  return await db
    .select()
    .from(kiloclaw_subscription_change_log)
    .where(inArray(kiloclaw_subscription_change_log.subscription_id, subscriptionIds))
    .orderBy(
      kiloclaw_subscription_change_log.created_at,
      kiloclaw_subscription_change_log.subscription_id
    );
}

function expectTransferredToTargets(
  subscriptions: Awaited<ReturnType<typeof listUserSubscriptions>>,
  expectedTargets: Record<string, string | null>
) {
  expect(
    Object.fromEntries(
      subscriptions.map(subscription => [
        subscription.id,
        subscription.transferred_to_subscription_id,
      ])
    )
  ).toEqual(expectedTargets);
}

async function expectCurrentHead(params: { subscriptionId: string; userId: string }) {
  const currentRows = await listCurrentPersonalSubscriptionRows({ userId: params.userId });
  expect(currentRows).toHaveLength(1);
  expect(currentRows[0]?.subscription.id).toBe(params.subscriptionId);
}

async function expectNoChangeLogsForSubscriptions(subscriptionIds: string[]) {
  const logs = await listChangeLogsForSubscriptions(subscriptionIds);
  expect(logs).toHaveLength(0);
}

async function expectChangeLogsForSubscriptions(expectedEntries: ExpectedChangeLogEntry[]) {
  const logs = await listChangeLogsForSubscriptions(
    expectedEntries.map(entry => entry.subscriptionId)
  );

  expect(logs).toHaveLength(expectedEntries.length);

  for (const entry of expectedEntries) {
    const log = logs.find(
      candidate =>
        candidate.subscription_id === entry.subscriptionId &&
        candidate.action === entry.action &&
        candidate.reason === entry.reason
    );

    expect(log).toBeDefined();
    if (!log) {
      continue;
    }

    expect(log).toEqual(
      expect.objectContaining({
        actor_type: TEST_ACTOR.actorType,
        actor_id: TEST_ACTOR.actorId,
        action: entry.action,
        reason: entry.reason,
      })
    );

    const expectedBeforeState = {
      id: entry.subscriptionId,
      transferred_to_subscription_id: entry.beforeTransferredTo,
      plan: entry.beforePlan,
      status: entry.beforeStatus,
      ...(entry.beforeStripeSubscriptionId !== undefined
        ? { stripe_subscription_id: entry.beforeStripeSubscriptionId }
        : {}),
      ...(entry.beforeStripeScheduleId !== undefined
        ? { stripe_schedule_id: entry.beforeStripeScheduleId }
        : {}),
    };

    const expectedAfterState = {
      id: entry.subscriptionId,
      transferred_to_subscription_id: entry.afterTransferredTo,
      plan: entry.afterPlan ?? entry.beforePlan,
      status: entry.afterStatus ?? entry.beforeStatus,
      ...(entry.afterStripeSubscriptionId !== undefined ||
      entry.beforeStripeSubscriptionId !== undefined
        ? {
            stripe_subscription_id:
              entry.afterStripeSubscriptionId ?? entry.beforeStripeSubscriptionId ?? null,
          }
        : {}),
      ...(entry.afterStripeScheduleId !== undefined || entry.beforeStripeScheduleId !== undefined
        ? {
            stripe_schedule_id: entry.afterStripeScheduleId ?? entry.beforeStripeScheduleId ?? null,
          }
        : {}),
    };

    expect(log.before_state).toEqual(expect.objectContaining(expectedBeforeState));
    expect(log.after_state).toEqual(expect.objectContaining(expectedAfterState));
  }
}

function expectCollapseStructuredLog(params: {
  destroyedInstanceId: string;
  headPlan: PersonalPlan;
  headStatus: PersonalStatus;
  headStripeSubscriptionId: string | null;
  headSubscriptionId: string;
  rowCountAlive: number;
  rowCountTotal: number;
  updateCount: number;
  userId: string;
}) {
  expect(console.log).toHaveBeenCalledTimes(1);
  expect(console.log).toHaveBeenCalledWith(
    'personal_subscription_destroy_collapse_applied',
    expect.objectContaining(params)
  );
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
        reason: DESTROY_REASON,
        userId: user.id,
      });
    });

    await expectCurrentHead({ subscriptionId: subscriptionC, userId: user.id });

    const subscriptions = await listUserSubscriptions(user.id);
    expectTransferredToTargets(subscriptions, {
      [subscriptionA]: subscriptionB,
      [subscriptionB]: subscriptionC,
      [subscriptionC]: null,
    });

    await expectChangeLogsForSubscriptions([
      {
        subscriptionId: subscriptionA,
        action: 'reassigned',
        reason: DESTROY_REASON,
        beforeTransferredTo: null,
        afterTransferredTo: subscriptionB,
        beforePlan: 'trial',
        beforeStatus: 'canceled',
      },
      {
        subscriptionId: subscriptionB,
        action: 'reassigned',
        reason: DESTROY_REASON,
        beforeTransferredTo: null,
        afterTransferredTo: subscriptionC,
        beforePlan: 'standard',
        beforeStatus: 'canceled',
      },
    ]);

    expectCollapseStructuredLog({
      userId: user.id,
      destroyedInstanceId: instanceC,
      rowCountTotal: 3,
      rowCountAlive: 0,
      headSubscriptionId: subscriptionC,
      headPlan: 'standard',
      headStatus: 'active',
      headStripeSubscriptionId: null,
      updateCount: 2,
    });
  });

  it('keeps an older funded commit row at the head above destroyed trials', async () => {
    const user = await insertTestUser({
      google_user_email: 'destroy-collapse-commit-head@example.com',
    });

    const commitInstanceId = crypto.randomUUID();
    const commitSubscriptionId = crypto.randomUUID();
    const trialSubscriptions: Array<{ instanceId: string; subscriptionId: string }> = [];

    await insertPersonalInstance({
      id: commitInstanceId,
      userId: user.id,
      createdAt: '2026-04-01T00:00:00.000Z',
    });
    await insertPersonalSubscription({
      id: commitSubscriptionId,
      userId: user.id,
      instanceId: commitInstanceId,
      createdAt: '2026-04-01T00:00:00.000Z',
      plan: 'commit',
      status: 'active',
    });

    for (let index = 0; index < 9; index += 1) {
      const instanceId = crypto.randomUUID();
      const subscriptionId = crypto.randomUUID();
      trialSubscriptions.push({ instanceId, subscriptionId });
      const createdAt = `2026-04-01T00:0${index + 1}:00.000Z`;

      await insertPersonalInstance({
        id: instanceId,
        userId: user.id,
        createdAt,
        destroyedAt: `2026-04-02T00:0${index + 1}:00.000Z`,
      });
      await insertPersonalSubscription({
        id: subscriptionId,
        userId: user.id,
        instanceId,
        createdAt,
        plan: 'trial',
        status: 'canceled',
      });
    }

    await db.transaction(async tx => {
      await markInstanceDestroyedWithPersonalSubscriptionCollapse({
        actor: TEST_ACTOR,
        executor: tx,
        instanceId: commitInstanceId,
        reason: DESTROY_REASON,
        userId: user.id,
      });
    });

    await expectCurrentHead({ subscriptionId: commitSubscriptionId, userId: user.id });

    const subscriptions = await listUserSubscriptions(user.id);
    const expectedTargets: Record<string, string | null> = {
      [commitSubscriptionId]: null,
    };
    for (const [index, trial] of trialSubscriptions.entries()) {
      expectedTargets[trial.subscriptionId] =
        trialSubscriptions[index + 1]?.subscriptionId ?? commitSubscriptionId;
    }
    expectTransferredToTargets(subscriptions, expectedTargets);

    await expectChangeLogsForSubscriptions(
      trialSubscriptions.map((trial, index) => ({
        subscriptionId: trial.subscriptionId,
        action: 'reassigned',
        reason: DESTROY_REASON,
        beforeTransferredTo: null,
        afterTransferredTo: trialSubscriptions[index + 1]?.subscriptionId ?? commitSubscriptionId,
        beforePlan: 'trial',
        beforeStatus: 'canceled',
      }))
    );

    expectCollapseStructuredLog({
      userId: user.id,
      destroyedInstanceId: commitInstanceId,
      rowCountTotal: 10,
      rowCountAlive: 0,
      headSubscriptionId: commitSubscriptionId,
      headPlan: 'commit',
      headStatus: 'active',
      headStripeSubscriptionId: null,
      updateCount: 9,
    });
  });

  it('keeps an older Stripe-funded standard row at the head above destroyed trials', async () => {
    const user = await insertTestUser({
      google_user_email: 'destroy-collapse-stripe-head@example.com',
    });

    const standardInstanceId = crypto.randomUUID();
    const standardSubscriptionId = crypto.randomUUID();
    const trialInstanceA = crypto.randomUUID();
    const trialInstanceB = crypto.randomUUID();
    const trialSubscriptionA = crypto.randomUUID();
    const trialSubscriptionB = crypto.randomUUID();

    await insertPersonalInstance({
      id: standardInstanceId,
      userId: user.id,
      createdAt: '2026-04-01T00:00:00.000Z',
    });
    await insertPersonalInstance({
      id: trialInstanceA,
      userId: user.id,
      createdAt: '2026-04-01T00:01:00.000Z',
      destroyedAt: '2026-04-02T00:01:00.000Z',
    });
    await insertPersonalInstance({
      id: trialInstanceB,
      userId: user.id,
      createdAt: '2026-04-01T00:02:00.000Z',
      destroyedAt: '2026-04-02T00:02:00.000Z',
    });

    await insertPersonalSubscription({
      id: standardSubscriptionId,
      userId: user.id,
      instanceId: standardInstanceId,
      createdAt: '2026-04-01T00:00:00.000Z',
      plan: 'standard',
      status: 'active',
      paymentSource: 'credits',
      stripeSubscriptionId: 'sub_destroy_collapse_standard',
    });
    await insertPersonalSubscription({
      id: trialSubscriptionA,
      userId: user.id,
      instanceId: trialInstanceA,
      createdAt: '2026-04-01T00:01:00.000Z',
      plan: 'trial',
      status: 'canceled',
    });
    await insertPersonalSubscription({
      id: trialSubscriptionB,
      userId: user.id,
      instanceId: trialInstanceB,
      createdAt: '2026-04-01T00:02:00.000Z',
      plan: 'trial',
      status: 'canceled',
    });

    await db.transaction(async tx => {
      await markInstanceDestroyedWithPersonalSubscriptionCollapse({
        actor: TEST_ACTOR,
        executor: tx,
        instanceId: standardInstanceId,
        reason: DESTROY_REASON,
        userId: user.id,
      });
    });

    await expectCurrentHead({ subscriptionId: standardSubscriptionId, userId: user.id });

    const subscriptions = await listUserSubscriptions(user.id);
    expectTransferredToTargets(subscriptions, {
      [standardSubscriptionId]: null,
      [trialSubscriptionA]: trialSubscriptionB,
      [trialSubscriptionB]: standardSubscriptionId,
    });

    await expectChangeLogsForSubscriptions([
      {
        subscriptionId: trialSubscriptionA,
        action: 'reassigned',
        reason: DESTROY_REASON,
        beforeTransferredTo: null,
        afterTransferredTo: trialSubscriptionB,
        beforePlan: 'trial',
        beforeStatus: 'canceled',
      },
      {
        subscriptionId: trialSubscriptionB,
        action: 'reassigned',
        reason: DESTROY_REASON,
        beforeTransferredTo: null,
        afterTransferredTo: standardSubscriptionId,
        beforePlan: 'trial',
        beforeStatus: 'canceled',
      },
    ]);

    expectCollapseStructuredLog({
      userId: user.id,
      destroyedInstanceId: standardInstanceId,
      rowCountTotal: 3,
      rowCountAlive: 0,
      headSubscriptionId: standardSubscriptionId,
      headPlan: 'standard',
      headStatus: 'active',
      headStripeSubscriptionId: 'sub_destroy_collapse_standard',
      updateCount: 2,
    });
  });

  it('keeps a Stripe-funded row with a schedule at the head above destroyed trials', async () => {
    const user = await insertTestUser({
      google_user_email: 'destroy-collapse-stripe-schedule-head@example.com',
    });

    const standardInstanceId = crypto.randomUUID();
    const standardSubscriptionId = crypto.randomUUID();
    const trialInstanceA = crypto.randomUUID();
    const trialInstanceB = crypto.randomUUID();
    const trialSubscriptionA = crypto.randomUUID();
    const trialSubscriptionB = crypto.randomUUID();

    await insertPersonalInstance({
      id: standardInstanceId,
      userId: user.id,
      createdAt: '2026-04-01T00:00:00.000Z',
    });
    await insertPersonalInstance({
      id: trialInstanceA,
      userId: user.id,
      createdAt: '2026-04-01T00:01:00.000Z',
      destroyedAt: '2026-04-02T00:01:00.000Z',
    });
    await insertPersonalInstance({
      id: trialInstanceB,
      userId: user.id,
      createdAt: '2026-04-01T00:02:00.000Z',
      destroyedAt: '2026-04-02T00:02:00.000Z',
    });

    await insertPersonalSubscription({
      id: standardSubscriptionId,
      userId: user.id,
      instanceId: standardInstanceId,
      createdAt: '2026-04-01T00:00:00.000Z',
      plan: 'standard',
      status: 'active',
      paymentSource: 'credits',
      stripeSubscriptionId: 'sub_destroy_collapse_scheduled',
      stripeScheduleId: 'sub_sched_destroy_collapse_scheduled',
    });
    await insertPersonalSubscription({
      id: trialSubscriptionA,
      userId: user.id,
      instanceId: trialInstanceA,
      createdAt: '2026-04-01T00:01:00.000Z',
      plan: 'trial',
      status: 'canceled',
    });
    await insertPersonalSubscription({
      id: trialSubscriptionB,
      userId: user.id,
      instanceId: trialInstanceB,
      createdAt: '2026-04-01T00:02:00.000Z',
      plan: 'trial',
      status: 'canceled',
    });

    await db.transaction(async tx => {
      await markInstanceDestroyedWithPersonalSubscriptionCollapse({
        actor: TEST_ACTOR,
        executor: tx,
        instanceId: standardInstanceId,
        reason: DESTROY_REASON,
        userId: user.id,
      });
    });

    await expectCurrentHead({ subscriptionId: standardSubscriptionId, userId: user.id });

    const currentRows = await listCurrentPersonalSubscriptionRows({ userId: user.id });
    expect(currentRows[0]?.subscription.stripe_schedule_id).toBe(
      'sub_sched_destroy_collapse_scheduled'
    );

    const subscriptions = await listUserSubscriptions(user.id);
    expectTransferredToTargets(subscriptions, {
      [standardSubscriptionId]: null,
      [trialSubscriptionA]: trialSubscriptionB,
      [trialSubscriptionB]: standardSubscriptionId,
    });

    await expectChangeLogsForSubscriptions([
      {
        subscriptionId: trialSubscriptionA,
        action: 'reassigned',
        reason: DESTROY_REASON,
        beforeTransferredTo: null,
        afterTransferredTo: trialSubscriptionB,
        beforePlan: 'trial',
        beforeStatus: 'canceled',
      },
      {
        subscriptionId: trialSubscriptionB,
        action: 'reassigned',
        reason: DESTROY_REASON,
        beforeTransferredTo: null,
        afterTransferredTo: standardSubscriptionId,
        beforePlan: 'trial',
        beforeStatus: 'canceled',
      },
    ]);

    expectCollapseStructuredLog({
      userId: user.id,
      destroyedInstanceId: standardInstanceId,
      rowCountTotal: 3,
      rowCountAlive: 0,
      headSubscriptionId: standardSubscriptionId,
      headPlan: 'standard',
      headStatus: 'active',
      headStripeSubscriptionId: 'sub_destroy_collapse_scheduled',
      updateCount: 2,
    });
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
        reason: DESTROY_REASON,
        userId: user.id,
      });
    });

    const afterFirstRun = await listUserSubscriptions(user.id);
    expectTransferredToTargets(afterFirstRun, {
      [subscriptionA]: subscriptionB,
      [subscriptionB]: subscriptionC,
      [subscriptionC]: null,
    });

    const result = await db.transaction(async tx => {
      return await collapseOrphanPersonalSubscriptionsOnDestroy({
        actor: TEST_ACTOR,
        destroyedInstanceId: instanceC,
        executor: tx,
        reason: DESTROY_REASON,
        userId: user.id,
      });
    });

    expect(result.updatedSubscriptionIds).toHaveLength(0);

    await expectChangeLogsForSubscriptions([
      {
        subscriptionId: subscriptionA,
        action: 'reassigned',
        reason: DESTROY_REASON,
        beforeTransferredTo: subscriptionC,
        afterTransferredTo: subscriptionB,
        beforePlan: 'trial',
        beforeStatus: 'canceled',
      },
      {
        subscriptionId: subscriptionB,
        action: 'reassigned',
        reason: DESTROY_REASON,
        beforeTransferredTo: null,
        afterTransferredTo: subscriptionC,
        beforePlan: 'standard',
        beforeStatus: 'canceled',
      },
    ]);
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
      reason: DESTROY_REASON,
      userId: user.id,
    });

    expect(destroyed?.id).toBe(instanceC);
    expect(onChangeLogFailure).toHaveBeenCalledTimes(2);
    expect(onChangeLogFailure).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        error: changeLogFailure,
        reason: DESTROY_REASON,
        subscriptionId: subscriptionA,
        userId: user.id,
      })
    );
    expect(onChangeLogFailure).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        error: changeLogFailure,
        reason: DESTROY_REASON,
        subscriptionId: subscriptionB,
        userId: user.id,
      })
    );

    const subscriptions = await listUserSubscriptions(user.id);
    expectTransferredToTargets(subscriptions, {
      [subscriptionA]: subscriptionB,
      [subscriptionB]: subscriptionC,
      [subscriptionC]: null,
    });

    await expectNoChangeLogsForSubscriptions([subscriptionA, subscriptionB, subscriptionC]);
  });

  it('rolls back single-row cancellation when change-log insert fails in transaction', async () => {
    const user = await insertTestUser({
      google_user_email: 'destroy-cancel-single-rollback@example.com',
    });
    const instanceId = crypto.randomUUID();
    const subscriptionId = crypto.randomUUID();

    await insertPersonalInstance({
      id: instanceId,
      userId: user.id,
      createdAt: '2026-04-01T00:00:00.000Z',
    });
    await insertPersonalSubscription({
      id: subscriptionId,
      userId: user.id,
      instanceId,
      createdAt: '2026-04-01T00:00:00.000Z',
      plan: 'standard',
      status: 'active',
    });

    await expect(
      db.transaction(async tx => {
        const executor = Object.assign(Object.create(tx), {
          insert: ((table: typeof kiloclaw_subscription_change_log) => {
            if (table === kiloclaw_subscription_change_log) {
              return {
                values: async () => {
                  throw new Error('change-log insert failed');
                },
              };
            }
            return tx.insert(table);
          }) as typeof tx.insert,
        });

        await markInstanceDestroyedWithPersonalSubscriptionCollapse({
          actor: TEST_ACTOR,
          executor,
          instanceId,
          reason: DESTROY_REASON,
          userId: user.id,
        });
      })
    ).rejects.toThrow('change-log insert failed');

    const [subscription] = await db
      .select()
      .from(kiloclaw_subscriptions)
      .where(eq(kiloclaw_subscriptions.id, subscriptionId));
    const [instance] = await db
      .select()
      .from(kiloclaw_instances)
      .where(eq(kiloclaw_instances.id, instanceId));

    expect(subscription?.status).toBe('active');
    expect(instance?.destroyed_at).toBeNull();
    await expectNoChangeLogsForSubscriptions([subscriptionId]);
  });

  it('does not auto-cancel single destroyed Stripe or hybrid current row on destroy path', async () => {
    const stripeUser = await insertTestUser({
      google_user_email: 'destroy-cancel-single-stripe@example.com',
    });
    const hybridUser = await insertTestUser({
      google_user_email: 'destroy-cancel-single-hybrid@example.com',
    });
    const stripeInstanceId = crypto.randomUUID();
    const hybridInstanceId = crypto.randomUUID();
    const stripeSubscriptionId = crypto.randomUUID();
    const hybridSubscriptionId = crypto.randomUUID();

    await insertPersonalInstance({
      id: stripeInstanceId,
      userId: stripeUser.id,
      createdAt: '2026-04-01T00:00:00.000Z',
    });
    await insertPersonalInstance({
      id: hybridInstanceId,
      userId: hybridUser.id,
      createdAt: '2026-04-01T00:00:00.000Z',
    });
    await insertPersonalSubscription({
      id: stripeSubscriptionId,
      userId: stripeUser.id,
      instanceId: stripeInstanceId,
      createdAt: '2026-04-01T00:00:00.000Z',
      plan: 'standard',
      status: 'active',
      paymentSource: 'stripe',
      stripeSubscriptionId: 'sub_destroy_path_stripe',
    });
    await insertPersonalSubscription({
      id: hybridSubscriptionId,
      userId: hybridUser.id,
      instanceId: hybridInstanceId,
      createdAt: '2026-04-01T00:00:00.000Z',
      plan: 'standard',
      status: 'active',
      paymentSource: 'credits',
      stripeSubscriptionId: 'sub_destroy_path_hybrid',
    });

    await db.transaction(async tx => {
      await markInstanceDestroyedWithPersonalSubscriptionCollapse({
        actor: TEST_ACTOR,
        executor: tx,
        instanceId: stripeInstanceId,
        reason: DESTROY_REASON,
        userId: stripeUser.id,
      });
      await markInstanceDestroyedWithPersonalSubscriptionCollapse({
        actor: TEST_ACTOR,
        executor: tx,
        instanceId: hybridInstanceId,
        reason: DESTROY_REASON,
        userId: hybridUser.id,
      });
    });

    const subscriptions = await db
      .select()
      .from(kiloclaw_subscriptions)
      .where(inArray(kiloclaw_subscriptions.id, [stripeSubscriptionId, hybridSubscriptionId]));

    expect(subscriptions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: stripeSubscriptionId, status: 'active' }),
        expect.objectContaining({ id: hybridSubscriptionId, status: 'active' }),
      ])
    );
    await expectNoChangeLogsForSubscriptions([stripeSubscriptionId, hybridSubscriptionId]);
    expect(console.log).not.toHaveBeenCalled();
  });

  it('cancels a single destroyed current access row without entering the chain-build path', async () => {
    const user = await insertTestUser({
      google_user_email: 'destroy-cancel-single-current@example.com',
    });
    const instanceId = crypto.randomUUID();
    const subscriptionId = crypto.randomUUID();

    await insertPersonalInstance({
      id: instanceId,
      userId: user.id,
      createdAt: '2026-04-01T00:00:00.000Z',
    });
    await insertPersonalSubscription({
      id: subscriptionId,
      userId: user.id,
      instanceId,
      createdAt: '2026-04-01T00:00:00.000Z',
      plan: 'standard',
      status: 'active',
    });

    await db.transaction(async tx => {
      await markInstanceDestroyedWithPersonalSubscriptionCollapse({
        actor: TEST_ACTOR,
        executor: tx,
        instanceId,
        reason: DESTROY_REASON,
        userId: user.id,
      });
    });

    const [subscription] = await db
      .select()
      .from(kiloclaw_subscriptions)
      .where(eq(kiloclaw_subscriptions.id, subscriptionId));

    expect(subscription?.status).toBe('canceled');
    expect(subscription?.transferred_to_subscription_id).toBeNull();

    await expectChangeLogsForSubscriptions([
      {
        subscriptionId,
        action: 'canceled',
        reason: CANCEL_SINGLE_REASON,
        beforeTransferredTo: null,
        afterTransferredTo: null,
        beforePlan: 'standard',
        beforeStatus: 'active',
        afterStatus: 'canceled',
      },
    ]);

    expect(console.log).not.toHaveBeenCalled();
  });

  it('refuses collapse when multiple alive current funded personal rows exist', async () => {
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
          reason: DESTROY_REASON,
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

    const subscriptions = await listUserSubscriptions(user.id);
    expectTransferredToTargets(subscriptions, {
      [subscriptionA]: null,
      [subscriptionB]: null,
    });

    await expectNoChangeLogsForSubscriptions([subscriptionA, subscriptionB]);
    expect(console.log).not.toHaveBeenCalled();
  });

  it('keeps the newest canceled trial at the head when all rows are destroyed trials', async () => {
    const user = await insertTestUser({
      google_user_email: 'destroy-collapse-all-trials@example.com',
    });

    const instanceA = crypto.randomUUID();
    const instanceB = crypto.randomUUID();
    const instanceC = crypto.randomUUID();
    const instanceD = crypto.randomUUID();
    const subscriptionA = crypto.randomUUID();
    const subscriptionB = crypto.randomUUID();
    const subscriptionC = crypto.randomUUID();
    const subscriptionD = crypto.randomUUID();

    await insertPersonalInstance({
      id: instanceA,
      userId: user.id,
      createdAt: '2026-04-01T00:00:00.000Z',
      destroyedAt: '2026-04-02T00:00:00.000Z',
    });
    await insertPersonalInstance({
      id: instanceB,
      userId: user.id,
      createdAt: '2026-04-01T00:01:00.000Z',
      destroyedAt: '2026-04-02T00:01:00.000Z',
    });
    await insertPersonalInstance({
      id: instanceC,
      userId: user.id,
      createdAt: '2026-04-01T00:02:00.000Z',
      destroyedAt: '2026-04-02T00:02:00.000Z',
    });
    await insertPersonalInstance({
      id: instanceD,
      userId: user.id,
      createdAt: '2026-04-01T00:03:00.000Z',
    });

    await insertPersonalSubscription({
      id: subscriptionA,
      userId: user.id,
      instanceId: instanceA,
      createdAt: '2026-04-01T00:00:00.000Z',
      plan: 'trial',
      status: 'canceled',
    });
    await insertPersonalSubscription({
      id: subscriptionB,
      userId: user.id,
      instanceId: instanceB,
      createdAt: '2026-04-01T00:01:00.000Z',
      plan: 'trial',
      status: 'canceled',
    });
    await insertPersonalSubscription({
      id: subscriptionC,
      userId: user.id,
      instanceId: instanceC,
      createdAt: '2026-04-01T00:02:00.000Z',
      plan: 'trial',
      status: 'canceled',
    });
    await insertPersonalSubscription({
      id: subscriptionD,
      userId: user.id,
      instanceId: instanceD,
      createdAt: '2026-04-01T00:03:00.000Z',
      plan: 'trial',
      status: 'canceled',
    });

    await db.transaction(async tx => {
      await markInstanceDestroyedWithPersonalSubscriptionCollapse({
        actor: TEST_ACTOR,
        executor: tx,
        instanceId: instanceD,
        reason: DESTROY_REASON,
        userId: user.id,
      });
    });

    await expectCurrentHead({ subscriptionId: subscriptionD, userId: user.id });

    const subscriptions = await listUserSubscriptions(user.id);
    expectTransferredToTargets(subscriptions, {
      [subscriptionA]: subscriptionB,
      [subscriptionB]: subscriptionC,
      [subscriptionC]: subscriptionD,
      [subscriptionD]: null,
    });

    await expectChangeLogsForSubscriptions([
      {
        subscriptionId: subscriptionA,
        action: 'reassigned',
        reason: DESTROY_REASON,
        beforeTransferredTo: null,
        afterTransferredTo: subscriptionB,
        beforePlan: 'trial',
        beforeStatus: 'canceled',
      },
      {
        subscriptionId: subscriptionB,
        action: 'reassigned',
        reason: DESTROY_REASON,
        beforeTransferredTo: null,
        afterTransferredTo: subscriptionC,
        beforePlan: 'trial',
        beforeStatus: 'canceled',
      },
      {
        subscriptionId: subscriptionC,
        action: 'reassigned',
        reason: DESTROY_REASON,
        beforeTransferredTo: null,
        afterTransferredTo: subscriptionD,
        beforePlan: 'trial',
        beforeStatus: 'canceled',
      },
    ]);

    expectCollapseStructuredLog({
      userId: user.id,
      destroyedInstanceId: instanceD,
      rowCountTotal: 4,
      rowCountAlive: 0,
      headSubscriptionId: subscriptionD,
      headPlan: 'trial',
      headStatus: 'canceled',
      headStripeSubscriptionId: null,
      updateCount: 3,
    });
  });

  it('refuses to demote a funded row when a bad transfer plan is injected', async () => {
    const user = await insertTestUser({
      google_user_email: 'destroy-collapse-refuse-funded-demotion@example.com',
    });

    const fundedInstanceId = crypto.randomUUID();
    const trialInstanceId = crypto.randomUUID();
    const fundedSubscriptionId = crypto.randomUUID();
    const trialSubscriptionId = crypto.randomUUID();

    await insertPersonalInstance({
      id: fundedInstanceId,
      userId: user.id,
      createdAt: '2026-04-01T00:00:00.000Z',
    });
    await insertPersonalInstance({
      id: trialInstanceId,
      userId: user.id,
      createdAt: '2026-04-01T00:01:00.000Z',
      destroyedAt: '2026-04-02T00:01:00.000Z',
    });

    await insertPersonalSubscription({
      id: fundedSubscriptionId,
      userId: user.id,
      instanceId: fundedInstanceId,
      createdAt: '2026-04-01T00:00:00.000Z',
      plan: 'commit',
      status: 'active',
    });
    await insertPersonalSubscription({
      id: trialSubscriptionId,
      userId: user.id,
      instanceId: trialInstanceId,
      createdAt: '2026-04-01T00:01:00.000Z',
      plan: 'trial',
      status: 'canceled',
    });

    const destroyPromise = db.transaction(async tx => {
      await markInstanceDestroyedWithPersonalSubscriptionCollapse({
        actor: TEST_ACTOR,
        buildTransferUpdatesOverride: ({ rows }) => {
          const fundedRow = rows.find(row => row.subscription.id === fundedSubscriptionId);
          const trialRow = rows.find(row => row.subscription.id === trialSubscriptionId);

          expect(fundedRow).toBeDefined();
          expect(trialRow).toBeDefined();
          if (!fundedRow || !trialRow) {
            return [];
          }

          return [
            {
              before: fundedRow.subscription,
              transferredToSubscriptionId: trialRow.subscription.id,
            },
          ];
        },
        executor: tx,
        instanceId: fundedInstanceId,
        reason: DESTROY_REASON,
        userId: user.id,
      });
    });

    await expect(destroyPromise).rejects.toBeInstanceOf(FundedRowDemotionRefusedError);
    await expect(destroyPromise).rejects.toMatchObject({
      userId: user.id,
      destroyedInstanceId: fundedInstanceId,
      demotionCandidateSubscriptionId: fundedSubscriptionId,
    });

    const [instance] = await db
      .select()
      .from(kiloclaw_instances)
      .where(eq(kiloclaw_instances.id, fundedInstanceId));
    expect(instance?.destroyed_at).toBeNull();

    const subscriptions = await listUserSubscriptions(user.id);
    expectTransferredToTargets(subscriptions, {
      [fundedSubscriptionId]: null,
      [trialSubscriptionId]: null,
    });

    await expectNoChangeLogsForSubscriptions([fundedSubscriptionId, trialSubscriptionId]);
    expect(console.log).not.toHaveBeenCalled();
  });
});
