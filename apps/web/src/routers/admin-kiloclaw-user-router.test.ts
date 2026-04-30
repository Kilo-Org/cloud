import { db, cleanupDbForTest } from '@/lib/drizzle';
import { createCallerForUser } from '@/routers/test-utils';
import { insertTestUser } from '@/tests/helpers/user.helper';
import { createTestOrganization } from '@/tests/helpers/organization.helper';
import {
  kiloclaw_admin_audit_logs,
  kiloclaw_subscription_change_log,
  kiloclaw_instances,
  kiloclaw_subscriptions,
} from '@kilocode/db/schema';
import { count, eq } from 'drizzle-orm';
import { insertKiloClawSubscriptionChangeLog } from '@kilocode/db';
import type { User } from '@kilocode/db/schema';
import { client as stripeMock } from '@/lib/stripe-client';

const mockKiloclawStart = jest.fn();
const startedResponse = {
  ok: true,
  started: true,
  previousStatus: 'stopped',
  currentStatus: 'running',
  startedAt: 1_776_885_000_000,
};

jest.mock('@/lib/kiloclaw/kiloclaw-internal-client', () => ({
  KiloClawInternalClient: jest.fn().mockImplementation(() => ({
    start: mockKiloclawStart,
  })),
}));

let adminUser: User;
let targetUser: User;

function expectSameInstant(actual: string | null | undefined, expected: string) {
  expect(actual).not.toBeNull();
  expect(actual).toBeDefined();
  expect(new Date(actual as string).toISOString()).toBe(new Date(expected).toISOString());
}

beforeEach(async () => {
  await cleanupDbForTest();
  mockKiloclawStart.mockReset();
  mockKiloclawStart.mockResolvedValue(startedResponse);
  jest.spyOn(stripeMock.subscriptions, 'retrieve').mockResolvedValue({ schedule: null } as never);
  jest.spyOn(stripeMock.subscriptions, 'update').mockResolvedValue({} as never);
  jest.spyOn(stripeMock.subscriptions, 'cancel').mockResolvedValue({} as never);
  jest.spyOn(stripeMock.subscriptionSchedules, 'release').mockResolvedValue({} as never);

  adminUser = await insertTestUser({
    google_user_email: 'admin-kiloclaw-user-router@example.com',
    google_user_name: 'Admin User',
    is_admin: true,
  });

  targetUser = await insertTestUser({
    google_user_email: 'target-kiloclaw-user-router@example.com',
    google_user_name: 'Target User',
  });
});

afterAll(async () => {
  try {
    await cleanupDbForTest();
  } catch {
    // Database may already be torn down by the test runner.
  }
});

describe('admin.users.getKiloClawState', () => {
  it('returns an empty state when the user has no KiloClaw subscription', async () => {
    const caller = await createCallerForUser(adminUser.id);
    const result = await caller.admin.users.getKiloClawState({ userId: targetUser.id });

    expect(result).toEqual({
      subscription: null,
      effectiveSubscriptionId: null,
      subscriptions: [],
      hasAccess: false,
      accessReason: null,
      earlybird: null,
      activeInstanceId: null,
      kiloclawEarlyAccess: false,
      billingStateError: null,
      needsSupportReview: false,
    });
  });

  it('returns subscription access for active subscriptions', async () => {
    const [instance] = await db
      .insert(kiloclaw_instances)
      .values({
        user_id: targetUser.id,
        sandbox_id: 'sandbox-admin-kiloclaw-active',
      })
      .returning();

    await db.insert(kiloclaw_subscriptions).values({
      user_id: targetUser.id,
      instance_id: instance.id,
      plan: 'standard',
      status: 'active',
      stripe_subscription_id: 'sub_admin_kiloclaw_active',
    });

    const caller = await createCallerForUser(adminUser.id);
    const result = await caller.admin.users.getKiloClawState({ userId: targetUser.id });

    expect(result.subscription?.status).toBe('active');
    expect(result.subscription?.plan).toBe('standard');
    expect(result.hasAccess).toBe(true);
    expect(result.accessReason).toBe('subscription');
    expect(result.earlybird).toBeNull();

    // New fields
    expect(result.subscriptions).toHaveLength(1);
    expect(result.subscriptions[0].status).toBe('active');
    expect(result.effectiveSubscriptionId).toBe(result.subscriptions[0].id);
  });

  it('prefers an active personal current row over an older canceled row', async () => {
    const [oldInstance, activeInstance] = await db
      .insert(kiloclaw_instances)
      .values([
        {
          user_id: targetUser.id,
          sandbox_id: 'sandbox-admin-kiloclaw-canceled',
          destroyed_at: '2026-03-01T00:00:00.000Z',
        },
        {
          user_id: targetUser.id,
          sandbox_id: 'sandbox-admin-kiloclaw-active-latest',
        },
      ])
      .returning();

    const [activeSub] = await db
      .insert(kiloclaw_subscriptions)
      .values({
        user_id: targetUser.id,
        instance_id: activeInstance.id,
        plan: 'standard',
        status: 'active',
        stripe_subscription_id: 'sub_admin_kiloclaw_active_latest',
        current_period_end: '2026-05-01T00:00:00.000Z',
      })
      .returning();

    await db.insert(kiloclaw_subscriptions).values({
      user_id: targetUser.id,
      instance_id: oldInstance.id,
      plan: 'standard',
      status: 'canceled',
      stripe_subscription_id: 'sub_admin_kiloclaw_canceled',
      current_period_end: '2026-03-01T00:00:00.000Z',
      transferred_to_subscription_id: activeSub.id,
    });

    const caller = await createCallerForUser(adminUser.id);
    const result = await caller.admin.users.getKiloClawState({ userId: targetUser.id });

    expect(result.subscription?.status).toBe('active');
    expect(result.subscription?.stripe_subscription_id).toBe('sub_admin_kiloclaw_active_latest');
    expect(result.hasAccess).toBe(true);
    expect(result.accessReason).toBe('subscription');

    // Both rows returned in subscriptions
    expect(result.subscriptions).toHaveLength(2);
    expect(result.effectiveSubscriptionId).toBe(result.subscription?.id);
  });

  it('returns trial access for future trial end dates', async () => {
    const futureTrialEnd = new Date(Date.now() + 5 * 86_400_000).toISOString();

    const [instance] = await db
      .insert(kiloclaw_instances)
      .values({
        user_id: targetUser.id,
        sandbox_id: 'sandbox-admin-kiloclaw-trial',
      })
      .returning();

    await db.insert(kiloclaw_subscriptions).values({
      user_id: targetUser.id,
      instance_id: instance.id,
      plan: 'trial',
      status: 'trialing',
      trial_started_at: new Date().toISOString(),
      trial_ends_at: futureTrialEnd,
    });

    const caller = await createCallerForUser(adminUser.id);
    const result = await caller.admin.users.getKiloClawState({ userId: targetUser.id });

    expect(result.subscription?.status).toBe('trialing');
    expectSameInstant(result.subscription?.trial_ends_at, futureTrialEnd);
    expect(result.hasAccess).toBe(true);
    expect(result.accessReason).toBe('trial');
    expect(result.subscriptions).toHaveLength(1);
  });

  it('shows expired trial rows without trial access', async () => {
    const expiredTrialEnd = new Date(Date.now() - 2 * 86_400_000).toISOString();

    const [instance] = await db
      .insert(kiloclaw_instances)
      .values({
        user_id: targetUser.id,
        sandbox_id: 'sandbox-admin-kiloclaw-expired-trial',
      })
      .returning();

    await db.insert(kiloclaw_subscriptions).values({
      user_id: targetUser.id,
      instance_id: instance.id,
      plan: 'trial',
      status: 'trialing',
      trial_started_at: new Date(Date.now() - 10 * 86_400_000).toISOString(),
      trial_ends_at: expiredTrialEnd,
    });

    const caller = await createCallerForUser(adminUser.id);
    const result = await caller.admin.users.getKiloClawState({ userId: targetUser.id });

    expectSameInstant(result.subscription?.trial_ends_at, expiredTrialEnd);
    expect(result.hasAccess).toBe(false);
    expect(result.accessReason).toBeNull();
  });

  it('keeps personal access separate from organization-managed subscriptions', async () => {
    const organization = await createTestOrganization('Org Access Test', targetUser.id, 0);

    const [personalInstance, orgInstance] = await db
      .insert(kiloclaw_instances)
      .values([
        {
          user_id: targetUser.id,
          sandbox_id: 'sandbox-admin-kiloclaw-personal-canceled',
        },
        {
          user_id: targetUser.id,
          organization_id: organization.id,
          sandbox_id: 'sandbox-admin-kiloclaw-org-active',
        },
      ])
      .returning();

    await db.insert(kiloclaw_subscriptions).values([
      {
        user_id: targetUser.id,
        instance_id: personalInstance.id,
        plan: 'trial',
        status: 'canceled',
        cancel_at_period_end: false,
        trial_started_at: '2026-04-01T00:00:00.000Z',
        trial_ends_at: '2026-04-08T00:00:00.000Z',
      },
      {
        user_id: targetUser.id,
        instance_id: orgInstance.id,
        plan: 'standard',
        status: 'active',
        payment_source: 'credits',
        cancel_at_period_end: false,
      },
    ]);

    const caller = await createCallerForUser(adminUser.id);
    const result = await caller.admin.users.getKiloClawState({ userId: targetUser.id });

    expect(result.hasAccess).toBe(false);
    expect(result.accessReason).toBeNull();
    expect(result.subscription).toEqual(
      expect.objectContaining({
        instance_id: personalInstance.id,
        plan: 'trial',
        status: 'canceled',
      })
    );

    const personalSubscription = result.subscriptions.find(
      subscription => subscription.instance_id === personalInstance.id
    );
    const orgSubscription = result.subscriptions.find(
      subscription => subscription.instance_id === orgInstance.id
    );

    expect(personalSubscription?.instance).toEqual(
      expect.objectContaining({
        organization_id: null,
        organization_name: null,
      })
    );
    expect(orgSubscription?.instance).toEqual(
      expect.objectContaining({
        organization_id: organization.id,
        organization_name: organization.name,
      })
    );
  });

  it('returns earlybird access from canonical subscription row', async () => {
    const [instance] = await db
      .insert(kiloclaw_instances)
      .values({
        user_id: targetUser.id,
        sandbox_id: 'sandbox-earlybird-admin-test',
      })
      .returning({ id: kiloclaw_instances.id });

    await db.insert(kiloclaw_subscriptions).values({
      user_id: targetUser.id,
      instance_id: instance!.id,
      plan: 'trial',
      status: 'trialing',
      access_origin: 'earlybird',
      cancel_at_period_end: false,
      trial_started_at: '2026-01-01T00:00:00.000Z',
      trial_ends_at: '2026-09-26T00:00:00.000Z',
    });

    const caller = await createCallerForUser(adminUser.id);
    const result = await caller.admin.users.getKiloClawState({ userId: targetUser.id });

    expect(result.subscription).toEqual(
      expect.objectContaining({
        access_origin: 'earlybird',
      })
    );
    expect(result.hasAccess).toBe(true);
    expect(result.accessReason).toBe('earlybird');
    expect(result.earlybird).toEqual(
      expect.objectContaining({
        purchased: true,
        expiresAt: expect.any(String),
        daysRemaining: expect.any(Number),
      })
    );
    expect(result.subscriptions).toHaveLength(1);
  });

  it('returns activeInstanceId when the user has an active instance', async () => {
    const [instance] = await db
      .insert(kiloclaw_instances)
      .values({
        user_id: targetUser.id,
        sandbox_id: 'sandbox-test-active',
      })
      .returning({ id: kiloclaw_instances.id });

    const caller = await createCallerForUser(adminUser.id);
    const result = await caller.admin.users.getKiloClawState({ userId: targetUser.id });

    expect(result.activeInstanceId).toBe(instance.id);
  });

  it('returns null activeInstanceId when the user only has destroyed instances', async () => {
    await db.insert(kiloclaw_instances).values({
      user_id: targetUser.id,
      sandbox_id: 'sandbox-test-destroyed',
      destroyed_at: new Date().toISOString(),
    });

    const caller = await createCallerForUser(adminUser.id);
    const result = await caller.admin.users.getKiloClawState({ userId: targetUser.id });

    expect(result.activeInstanceId).toBeNull();
  });

  it('includes joined instance metadata on subscription rows', async () => {
    const [instance] = await db
      .insert(kiloclaw_instances)
      .values({
        user_id: targetUser.id,
        sandbox_id: 'sandbox-inst-meta',
        name: 'my-instance',
      })
      .returning();

    await db.insert(kiloclaw_subscriptions).values({
      user_id: targetUser.id,
      plan: 'standard',
      status: 'active',
      instance_id: instance.id,
      payment_source: 'credits',
    });

    const caller = await createCallerForUser(adminUser.id);
    const result = await caller.admin.users.getKiloClawState({ userId: targetUser.id });

    expect(result.subscriptions).toHaveLength(1);
    const sub = result.subscriptions[0];
    expect(sub.instance).toEqual(
      expect.objectContaining({
        id: instance.id,
        name: 'my-instance',
        sandbox_id: 'sandbox-inst-meta',
        destroyed_at: null,
      })
    );
  });

  it('ignores transferred historical rows when selecting effective access', async () => {
    const futureTrialEnd = new Date(Date.now() + 30 * 86_400_000).toISOString();
    const [historicalInstance, currentInstance] = await db
      .insert(kiloclaw_instances)
      .values([
        {
          user_id: targetUser.id,
          sandbox_id: 'sandbox-transferred-history',
          destroyed_at: '2026-04-01T00:00:00.000Z',
        },
        {
          user_id: targetUser.id,
          sandbox_id: 'sandbox-transferred-current',
        },
      ])
      .returning();

    const [currentSub] = await db
      .insert(kiloclaw_subscriptions)
      .values({
        user_id: targetUser.id,
        instance_id: currentInstance.id,
        plan: 'standard',
        status: 'active',
        payment_source: 'credits',
        current_period_end: '2026-05-01T00:00:00.000Z',
      })
      .returning();

    await db.insert(kiloclaw_subscriptions).values({
      user_id: targetUser.id,
      instance_id: historicalInstance.id,
      plan: 'trial',
      status: 'trialing',
      trial_started_at: '2026-04-01T00:00:00.000Z',
      trial_ends_at: futureTrialEnd,
      transferred_to_subscription_id: currentSub.id,
    });

    const caller = await createCallerForUser(adminUser.id);
    const result = await caller.admin.users.getKiloClawState({ userId: targetUser.id });

    expect(result.subscription?.id).toBe(currentSub.id);
    expect(result.effectiveSubscriptionId).toBe(currentSub.id);
    expect(result.hasAccess).toBe(true);
    expect(result.accessReason).toBe('subscription');
    expect(result.subscriptions).toHaveLength(2);
  });

  it('keeps admin state inspectable when current personal rows conflict', async () => {
    const [firstInstance, secondInstance] = await db
      .insert(kiloclaw_instances)
      .values([
        {
          user_id: targetUser.id,
          sandbox_id: 'sandbox-conflict-first',
        },
        {
          user_id: targetUser.id,
          sandbox_id: 'sandbox-conflict-second',
        },
      ])
      .returning();

    await db.insert(kiloclaw_subscriptions).values([
      {
        user_id: targetUser.id,
        instance_id: firstInstance.id,
        plan: 'standard',
        status: 'active',
        payment_source: 'credits',
      },
      {
        user_id: targetUser.id,
        instance_id: secondInstance.id,
        plan: 'standard',
        status: 'active',
        payment_source: 'credits',
      },
    ]);

    const caller = await createCallerForUser(adminUser.id);
    const result = await caller.admin.users.getKiloClawState({ userId: targetUser.id });

    expect(result.subscriptions).toHaveLength(2);
    expect(result.subscription).toBeNull();
    expect(result.effectiveSubscriptionId).toBeNull();
    expect(result.hasAccess).toBe(false);
    expect(result.accessReason).toBeNull();
    expect(result.needsSupportReview).toBe(true);
    expect(result.billingStateError).toContain(
      'Expected at most one current personal subscription row'
    );
  });

  it('uses detached non-transferred access rows when no current personal row grants access', async () => {
    const [subscription] = await db
      .insert(kiloclaw_subscriptions)
      .values({
        user_id: targetUser.id,
        instance_id: null,
        plan: 'standard',
        status: 'active',
        payment_source: 'credits',
      })
      .returning();

    const caller = await createCallerForUser(adminUser.id);
    const result = await caller.admin.users.getKiloClawState({ userId: targetUser.id });

    expect(result.subscription?.id).toBe(subscription.id);
    expect(result.effectiveSubscriptionId).toBe(subscription.id);
    expect(result.hasAccess).toBe(true);
    expect(result.accessReason).toBe('subscription');
    expect(result.billingStateError).toBeNull();
    expect(result.needsSupportReview).toBe(false);
  });

  it('surfaces support review when multiple detached rows grant access', async () => {
    await db.insert(kiloclaw_subscriptions).values([
      {
        user_id: targetUser.id,
        instance_id: null,
        plan: 'standard',
        status: 'active',
        payment_source: 'credits',
      },
      {
        user_id: targetUser.id,
        instance_id: null,
        plan: 'standard',
        status: 'past_due',
        payment_source: 'credits',
      },
    ]);

    const caller = await createCallerForUser(adminUser.id);
    const result = await caller.admin.users.getKiloClawState({ userId: targetUser.id });

    expect(result.subscriptions).toHaveLength(2);
    expect(result.subscription).toBeNull();
    expect(result.effectiveSubscriptionId).toBeNull();
    expect(result.hasAccess).toBe(false);
    expect(result.accessReason).toBeNull();
    expect(result.billingStateError).toBe(
      'Multiple detached access-granting KiloClaw subscription rows exist.'
    );
    expect(result.needsSupportReview).toBe(true);
  });

  it('returns subscription rows without eager-loading change log history', async () => {
    const [instance] = await db
      .insert(kiloclaw_instances)
      .values({
        user_id: targetUser.id,
        sandbox_id: 'sandbox-admin-kiloclaw-change-log',
      })
      .returning();
    const [subscription] = await db
      .insert(kiloclaw_subscriptions)
      .values({
        user_id: targetUser.id,
        instance_id: instance.id,
        plan: 'trial',
        status: 'trialing',
        trial_started_at: '2026-04-01T00:00:00.000Z',
        trial_ends_at: '2026-04-08T00:00:00.000Z',
      })
      .returning();

    await insertKiloClawSubscriptionChangeLog(db, {
      subscriptionId: subscription.id,
      action: 'created',
      actor: { actorType: 'system', actorId: 'test-bootstrap' },
      reason: 'initial_test_row',
      before: null,
      after: subscription,
    });
    const [updatedSubscription] = await db
      .update(kiloclaw_subscriptions)
      .set({ trial_ends_at: '2026-04-10T00:00:00.000Z' })
      .where(eq(kiloclaw_subscriptions.id, subscription.id))
      .returning();
    await insertKiloClawSubscriptionChangeLog(db, {
      subscriptionId: subscription.id,
      action: 'admin_override',
      actor: { actorType: 'user', actorId: adminUser.id },
      reason: 'admin_update_trial_end',
      before: subscription,
      after: updatedSubscription,
    });

    const caller = await createCallerForUser(adminUser.id);
    const result = await caller.admin.users.getKiloClawState({ userId: targetUser.id });

    expect(result.subscriptions).toHaveLength(1);
    expect('changeLogs' in result.subscriptions[0]).toBe(false);
  });

  it('lazy-loads subscription change log history', async () => {
    const [instance] = await db
      .insert(kiloclaw_instances)
      .values({
        user_id: targetUser.id,
        sandbox_id: 'sandbox-admin-kiloclaw-change-log-lazy',
      })
      .returning();
    const [subscription] = await db
      .insert(kiloclaw_subscriptions)
      .values({
        user_id: targetUser.id,
        instance_id: instance.id,
        plan: 'trial',
        status: 'trialing',
        trial_started_at: '2026-04-01T00:00:00.000Z',
        trial_ends_at: '2026-04-08T00:00:00.000Z',
      })
      .returning();

    await insertKiloClawSubscriptionChangeLog(db, {
      subscriptionId: subscription.id,
      action: 'created',
      actor: { actorType: 'system', actorId: 'test-bootstrap' },
      reason: 'initial_test_row',
      before: null,
      after: subscription,
    });
    const [updatedSubscription] = await db
      .update(kiloclaw_subscriptions)
      .set({ trial_ends_at: '2026-04-10T00:00:00.000Z' })
      .where(eq(kiloclaw_subscriptions.id, subscription.id))
      .returning();
    await insertKiloClawSubscriptionChangeLog(db, {
      subscriptionId: subscription.id,
      action: 'admin_override',
      actor: { actorType: 'user', actorId: adminUser.id },
      reason: 'admin_update_trial_end',
      before: subscription,
      after: updatedSubscription,
    });

    const caller = await createCallerForUser(adminUser.id);
    const result = await caller.admin.users.getKiloClawSubscriptionChangeLogs({
      userId: targetUser.id,
      subscriptionId: subscription.id,
    });

    expect(result.changeLogs).toHaveLength(2);
    expect(result.changeLogs[0]).toEqual(
      expect.objectContaining({
        subscription_id: subscription.id,
        action: 'admin_override',
        actor_type: 'user',
        actor_id: adminUser.id,
        reason: 'admin_update_trial_end',
      })
    );
    expectSameInstant(
      result.changeLogs[0].before_state?.trial_ends_at as string | null,
      '2026-04-08T00:00:00.000Z'
    );
    expectSameInstant(
      result.changeLogs[0].after_state?.trial_ends_at as string | null,
      '2026-04-10T00:00:00.000Z'
    );
    expect(result.changeLogs[1]).toEqual(
      expect.objectContaining({
        subscription_id: subscription.id,
        action: 'created',
        actor_type: 'system',
        actor_id: 'test-bootstrap',
        reason: 'initial_test_row',
      })
    );
  });

  it('rejects lazy-loading another user subscription change log history', async () => {
    const otherUser = await insertTestUser({
      google_user_email: 'other-kiloclaw-change-log@example.com',
      google_user_name: 'Other User',
    });
    const [subscription] = await db
      .insert(kiloclaw_subscriptions)
      .values({
        user_id: otherUser.id,
        plan: 'trial',
        status: 'trialing',
        trial_started_at: '2026-04-01T00:00:00.000Z',
        trial_ends_at: '2026-04-08T00:00:00.000Z',
      })
      .returning();

    const caller = await createCallerForUser(adminUser.id);

    await expect(
      caller.admin.users.getKiloClawSubscriptionChangeLogs({
        userId: targetUser.id,
        subscriptionId: subscription.id,
      })
    ).rejects.toThrow('Subscription not found or does not belong to this user');
  });

  it('returns multiple subscription rows with correct effective selection', async () => {
    const [instanceOld, instanceNew] = await db
      .insert(kiloclaw_instances)
      .values([
        {
          user_id: targetUser.id,
          sandbox_id: 'sandbox-multi-old',
          destroyed_at: new Date().toISOString(),
        },
        {
          user_id: targetUser.id,
          sandbox_id: 'sandbox-multi-new',
        },
      ])
      .returning();

    await db.insert(kiloclaw_subscriptions).values([
      {
        user_id: targetUser.id,
        plan: 'trial',
        status: 'canceled',
        instance_id: instanceOld.id,
        trial_started_at: '2026-01-01T00:00:00.000Z',
        trial_ends_at: '2026-01-08T00:00:00.000Z',
      },
      {
        user_id: targetUser.id,
        plan: 'standard',
        status: 'active',
        instance_id: instanceNew.id,
        payment_source: 'credits',
        current_period_end: '2026-05-01T00:00:00.000Z',
      },
    ]);

    const caller = await createCallerForUser(adminUser.id);
    const result = await caller.admin.users.getKiloClawState({ userId: targetUser.id });

    expect(result.subscriptions).toHaveLength(2);
    expect(result.subscription?.status).toBe('active');
    expect(result.effectiveSubscriptionId).toBe(result.subscription?.id);
    // Each subscription should have its respective instance joined
    const activeSub = result.subscriptions.find(s => s.status === 'active');
    const canceledSub = result.subscriptions.find(s => s.status === 'canceled');
    expect(activeSub?.instance?.id).toBe(instanceNew.id);
    expect(canceledSub?.instance?.id).toBe(instanceOld.id);
  });
});

describe('admin.users.updateKiloClawTrialEndAt', () => {
  it('updates the trial end date and writes an admin audit log entry', async () => {
    const previousTrialEndsAt = '2026-03-20T23:59:59.000Z';
    const newTrialEndsAt = '2026-03-25T23:59:59.000Z';

    const [sub] = await db
      .insert(kiloclaw_subscriptions)
      .values({
        user_id: targetUser.id,
        plan: 'trial',
        status: 'trialing',
        trial_started_at: '2026-03-13T12:00:00.000Z',
        trial_ends_at: previousTrialEndsAt,
      })
      .returning();

    const caller = await createCallerForUser(adminUser.id);
    const result = await caller.admin.users.updateKiloClawTrialEndAt({
      userId: targetUser.id,
      subscriptionId: sub.id,
      trial_ends_at: newTrialEndsAt,
    });

    expect(result).toEqual({ success: true });

    const updatedSubscription = await db.query.kiloclaw_subscriptions.findFirst({
      where: eq(kiloclaw_subscriptions.user_id, targetUser.id),
    });
    expectSameInstant(updatedSubscription?.trial_ends_at, newTrialEndsAt);

    const [auditLog] = await db
      .select()
      .from(kiloclaw_admin_audit_logs)
      .where(eq(kiloclaw_admin_audit_logs.target_user_id, targetUser.id));

    expect(auditLog).toEqual(
      expect.objectContaining({
        action: 'kiloclaw.subscription.update_trial_end',
        actor_id: adminUser.id,
        actor_email: adminUser.google_user_email,
        actor_name: adminUser.google_user_name,
        target_user_id: targetUser.id,
      })
    );
    expect(auditLog.message).toContain('KiloClaw trial end updated from');
    expect(auditLog.message).toContain(newTrialEndsAt);
    expectSameInstant(
      auditLog.metadata?.previousTrialEndsAt as string | undefined,
      previousTrialEndsAt
    );
    expect(auditLog.metadata?.newTrialEndsAt).toBe(newTrialEndsAt);
  });

  it('rejects unknown users', async () => {
    const caller = await createCallerForUser(adminUser.id);

    await expect(
      caller.admin.users.updateKiloClawTrialEndAt({
        userId: 'missing-user',
        subscriptionId: '00000000-0000-0000-0000-000000000000',
        trial_ends_at: '2026-03-25T23:59:59.000Z',
      })
    ).rejects.toThrow('User not found');
  });

  it('rejects users without a matching KiloClaw subscription row', async () => {
    const caller = await createCallerForUser(adminUser.id);

    await expect(
      caller.admin.users.updateKiloClawTrialEndAt({
        userId: targetUser.id,
        subscriptionId: '00000000-0000-0000-0000-000000000000',
        trial_ends_at: '2026-03-25T23:59:59.000Z',
      })
    ).rejects.toThrow('No KiloClaw subscription found for this user');
  });

  it('rejects non-trialing and non-canceled subscription rows', async () => {
    const [sub] = await db
      .insert(kiloclaw_subscriptions)
      .values({
        user_id: targetUser.id,
        plan: 'standard',
        status: 'active',
        stripe_subscription_id: 'sub_admin_kiloclaw_non_trial',
      })
      .returning();

    const caller = await createCallerForUser(adminUser.id);

    await expect(
      caller.admin.users.updateKiloClawTrialEndAt({
        userId: targetUser.id,
        subscriptionId: sub.id,
        trial_ends_at: '2026-03-25T23:59:59.000Z',
      })
    ).rejects.toThrow(
      'Only trialing or canceled KiloClaw subscriptions can have their trial end date edited'
    );
  });

  it('rejects trial edits for transferred historical rows and leaves row unchanged', async () => {
    const originalTrialEndsAt = '2026-03-20T23:59:59.000Z';
    const requestedTrialEndsAt = '2026-04-01T23:59:59.000Z';
    const [currentSub] = await db
      .insert(kiloclaw_subscriptions)
      .values({
        user_id: targetUser.id,
        plan: 'standard',
        status: 'active',
        payment_source: 'credits',
      })
      .returning();
    const [transferredSub] = await db
      .insert(kiloclaw_subscriptions)
      .values({
        user_id: targetUser.id,
        plan: 'trial',
        status: 'trialing',
        trial_started_at: '2026-03-13T12:00:00.000Z',
        trial_ends_at: originalTrialEndsAt,
        transferred_to_subscription_id: currentSub.id,
      })
      .returning();

    const caller = await createCallerForUser(adminUser.id);

    await expect(
      caller.admin.users.updateKiloClawTrialEndAt({
        userId: targetUser.id,
        subscriptionId: transferredSub.id,
        trial_ends_at: requestedTrialEndsAt,
      })
    ).rejects.toThrow(
      'Transferred KiloClaw subscriptions are historical and cannot be modified. Edit the current subscription instead.'
    );

    const unchanged = await db.query.kiloclaw_subscriptions.findFirst({
      where: eq(kiloclaw_subscriptions.id, transferredSub.id),
    });
    expect(unchanged?.status).toBe('trialing');
    expectSameInstant(unchanged?.trial_ends_at, originalTrialEndsAt);

    const [changeLogCount] = await db
      .select({ value: count() })
      .from(kiloclaw_subscription_change_log)
      .where(eq(kiloclaw_subscription_change_log.subscription_id, transferredSub.id));
    expect(changeLogCount?.value).toBe(0);
  });

  it('rejects trial resets for transferred historical rows and leaves row unchanged', async () => {
    const originalTrialEndsAt = '2026-03-15T23:59:59.000Z';
    const requestedTrialEndsAt = '2026-04-01T23:59:59.000Z';
    const originalSuspendedAt = '2026-03-16T00:00:00.000Z';
    const [currentSub] = await db
      .insert(kiloclaw_subscriptions)
      .values({
        user_id: targetUser.id,
        plan: 'standard',
        status: 'active',
        payment_source: 'credits',
      })
      .returning();
    const [transferredSub] = await db
      .insert(kiloclaw_subscriptions)
      .values({
        user_id: targetUser.id,
        plan: 'trial',
        status: 'canceled',
        trial_started_at: '2026-03-08T12:00:00.000Z',
        trial_ends_at: originalTrialEndsAt,
        suspended_at: originalSuspendedAt,
        destruction_deadline: '2026-03-23T00:00:00.000Z',
        transferred_to_subscription_id: currentSub.id,
      })
      .returning();

    const caller = await createCallerForUser(adminUser.id);

    await expect(
      caller.admin.users.updateKiloClawTrialEndAt({
        userId: targetUser.id,
        subscriptionId: transferredSub.id,
        trial_ends_at: requestedTrialEndsAt,
      })
    ).rejects.toThrow(
      'Transferred KiloClaw subscriptions are historical and cannot be modified. Edit the current subscription instead.'
    );

    const unchanged = await db.query.kiloclaw_subscriptions.findFirst({
      where: eq(kiloclaw_subscriptions.id, transferredSub.id),
    });
    expect(unchanged?.status).toBe('canceled');
    expectSameInstant(unchanged?.trial_ends_at, originalTrialEndsAt);
    expectSameInstant(unchanged?.suspended_at, originalSuspendedAt);

    const [changeLogCount] = await db
      .select({ value: count() })
      .from(kiloclaw_subscription_change_log)
      .where(eq(kiloclaw_subscription_change_log.subscription_id, transferredSub.id));
    expect(changeLogCount?.value).toBe(0);
  });

  it('resets a canceled subscription to a new trial', async () => {
    const previousTrialEndsAt = '2026-03-15T23:59:59.000Z';
    const newTrialEndsAt = '2026-04-01T23:59:59.000Z';

    const [sub] = await db
      .insert(kiloclaw_subscriptions)
      .values({
        user_id: targetUser.id,
        plan: 'trial',
        status: 'canceled',
        trial_started_at: '2026-03-08T12:00:00.000Z',
        trial_ends_at: previousTrialEndsAt,
        suspended_at: '2026-03-16T00:00:00.000Z',
        destruction_deadline: '2026-03-23T00:00:00.000Z',
      })
      .returning();

    const caller = await createCallerForUser(adminUser.id);
    const result = await caller.admin.users.updateKiloClawTrialEndAt({
      userId: targetUser.id,
      subscriptionId: sub.id,
      trial_ends_at: newTrialEndsAt,
    });

    expect(result).toEqual({ success: true });

    const updatedSubscription = await db.query.kiloclaw_subscriptions.findFirst({
      where: eq(kiloclaw_subscriptions.user_id, targetUser.id),
    });
    expect(updatedSubscription?.status).toBe('trialing');
    expect(updatedSubscription?.plan).toBe('trial');
    expectSameInstant(updatedSubscription?.trial_ends_at, newTrialEndsAt);
    expect(updatedSubscription?.trial_started_at).not.toBeNull();
    expect(updatedSubscription?.suspended_at).toBeNull();
    expect(updatedSubscription?.destruction_deadline).toBeNull();
    expect(updatedSubscription?.stripe_subscription_id).toBeNull();
    expect(updatedSubscription?.cancel_at_period_end).toBe(false);

    const [auditLog] = await db
      .select()
      .from(kiloclaw_admin_audit_logs)
      .where(eq(kiloclaw_admin_audit_logs.target_user_id, targetUser.id));

    expect(auditLog).toEqual(
      expect.objectContaining({
        action: 'kiloclaw.subscription.reset_trial',
        actor_id: adminUser.id,
        target_user_id: targetUser.id,
      })
    );
    expect(auditLog.message).toContain('reset from canceled to trialing');
    expect(auditLog.metadata?.isReset).toBe(true);
    expect(auditLog.metadata?.previousStatus).toBe('canceled');

    const [changeLog] = await db
      .select()
      .from(kiloclaw_subscription_change_log)
      .where(eq(kiloclaw_subscription_change_log.subscription_id, sub.id));
    expect(changeLog).toEqual(
      expect.objectContaining({
        actor_id: adminUser.id,
        action: 'reactivated',
        reason: 'admin_reset_trial',
      })
    );
  });

  it('clears the inactivity marker after a trial reset starts the personal instance', async () => {
    const newTrialEndsAt = '2026-04-01T23:59:59.000Z';
    const [instance] = await db
      .insert(kiloclaw_instances)
      .values({
        user_id: targetUser.id,
        sandbox_id: `ki_${crypto.randomUUID().replace(/-/g, '')}`,
        inactive_trial_stopped_at: '2026-03-20T12:00:00.000Z',
      })
      .returning();

    const [sub] = await db
      .insert(kiloclaw_subscriptions)
      .values({
        user_id: targetUser.id,
        instance_id: instance.id,
        plan: 'trial',
        status: 'canceled',
        trial_started_at: '2026-03-08T12:00:00.000Z',
        trial_ends_at: '2026-03-15T23:59:59.000Z',
        suspended_at: '2026-03-16T00:00:00.000Z',
        destruction_deadline: '2026-03-23T00:00:00.000Z',
      })
      .returning();

    const caller = await createCallerForUser(adminUser.id);
    const result = await caller.admin.users.updateKiloClawTrialEndAt({
      userId: targetUser.id,
      subscriptionId: sub.id,
      trial_ends_at: newTrialEndsAt,
    });

    expect(result).toEqual({ success: true });
    expect(mockKiloclawStart).toHaveBeenCalledWith(targetUser.id, instance.id, {
      reason: 'admin_request',
    });

    const updatedInstance = await db.query.kiloclaw_instances.findFirst({
      where: eq(kiloclaw_instances.id, instance.id),
    });
    expect(updatedInstance?.inactive_trial_stopped_at).toBeNull();
  });

  it('does not clear the inactivity marker when a trial reset start is a no-op', async () => {
    mockKiloclawStart.mockResolvedValueOnce({
      ok: true,
      started: false,
      previousStatus: 'stopped',
      currentStatus: 'stopped',
      startedAt: null,
    });

    const newTrialEndsAt = '2026-04-01T23:59:59.000Z';
    const [instance] = await db
      .insert(kiloclaw_instances)
      .values({
        user_id: targetUser.id,
        sandbox_id: `ki_${crypto.randomUUID().replace(/-/g, '')}`,
        inactive_trial_stopped_at: '2026-03-20T12:00:00.000Z',
      })
      .returning();

    const [sub] = await db
      .insert(kiloclaw_subscriptions)
      .values({
        user_id: targetUser.id,
        instance_id: instance.id,
        plan: 'trial',
        status: 'canceled',
        trial_started_at: '2026-03-08T12:00:00.000Z',
        trial_ends_at: '2026-03-15T23:59:59.000Z',
        suspended_at: '2026-03-16T00:00:00.000Z',
        destruction_deadline: '2026-03-23T00:00:00.000Z',
      })
      .returning();

    const caller = await createCallerForUser(adminUser.id);
    const result = await caller.admin.users.updateKiloClawTrialEndAt({
      userId: targetUser.id,
      subscriptionId: sub.id,
      trial_ends_at: newTrialEndsAt,
    });

    expect(result).toEqual({ success: true });

    const updatedInstance = await db.query.kiloclaw_instances.findFirst({
      where: eq(kiloclaw_instances.id, instance.id),
    });
    expect(new Date(String(updatedInstance?.inactive_trial_stopped_at)).toISOString()).toBe(
      '2026-03-20T12:00:00.000Z'
    );
  });
});

describe('admin.users.cancelKiloClawSubscription', () => {
  it('period-end cancel on pure-credit row is DB-only', async () => {
    const [sub] = await db
      .insert(kiloclaw_subscriptions)
      .values({
        user_id: targetUser.id,
        plan: 'standard',
        status: 'active',
        payment_source: 'credits',
        credit_renewal_at: new Date(Date.now() + 30 * 86_400_000).toISOString(),
      })
      .returning();

    const caller = await createCallerForUser(adminUser.id);
    const result = await caller.admin.users.cancelKiloClawSubscription({
      userId: targetUser.id,
      subscriptionId: sub.id,
      mode: 'period_end',
    });

    expect(result).toEqual({ success: true });

    // DB updated
    const updated = await db.query.kiloclaw_subscriptions.findFirst({
      where: eq(kiloclaw_subscriptions.id, sub.id),
    });
    expect(updated?.cancel_at_period_end).toBe(true);
    expect(updated?.scheduled_plan).toBeNull();
    expect(updated?.scheduled_by).toBeNull();
  });

  it('immediate cancel on pure-credit row sets local canceled', async () => {
    const [sub] = await db
      .insert(kiloclaw_subscriptions)
      .values({
        user_id: targetUser.id,
        plan: 'standard',
        status: 'active',
        payment_source: 'credits',
        credit_renewal_at: new Date(Date.now() + 30 * 86_400_000).toISOString(),
      })
      .returning();

    const caller = await createCallerForUser(adminUser.id);
    const result = await caller.admin.users.cancelKiloClawSubscription({
      userId: targetUser.id,
      subscriptionId: sub.id,
      mode: 'immediate',
    });

    expect(result).toEqual({ success: true });

    // DB updated — immediate cancel sets terminal state
    const updated = await db.query.kiloclaw_subscriptions.findFirst({
      where: eq(kiloclaw_subscriptions.id, sub.id),
    });
    expect(updated?.status).toBe('canceled');
    expect(updated?.cancel_at_period_end).toBe(false);
    expect(updated?.pending_conversion).toBe(false);
    expect(updated?.stripe_schedule_id).toBeNull();
    expect(updated?.scheduled_plan).toBeNull();
    expect(updated?.scheduled_by).toBeNull();
    // current_period_end and credit_renewal_at should be set to ~now
    expect(updated?.current_period_end).not.toBeNull();
    expect(updated?.credit_renewal_at).not.toBeNull();

    const [changeLog] = await db
      .select()
      .from(kiloclaw_subscription_change_log)
      .where(eq(kiloclaw_subscription_change_log.subscription_id, sub.id));
    expect(changeLog).toEqual(
      expect.objectContaining({
        actor_id: adminUser.id,
        action: 'canceled',
        reason: 'admin_cancel_immediate',
      })
    );
  });

  it('immediate cancel can cancel a row already pending period-end cancellation', async () => {
    const [sub] = await db
      .insert(kiloclaw_subscriptions)
      .values({
        user_id: targetUser.id,
        plan: 'standard',
        status: 'active',
        payment_source: 'credits',
        cancel_at_period_end: true,
      })
      .returning();

    const caller = await createCallerForUser(adminUser.id);
    const result = await caller.admin.users.cancelKiloClawSubscription({
      userId: targetUser.id,
      subscriptionId: sub.id,
      mode: 'immediate',
    });

    expect(result).toEqual({ success: true });

    const updated = await db.query.kiloclaw_subscriptions.findFirst({
      where: eq(kiloclaw_subscriptions.id, sub.id),
    });
    expect(updated?.status).toBe('canceled');
    expect(updated?.cancel_at_period_end).toBe(false);
  });

  it('rejects canceling transferred historical rows and leaves row unchanged', async () => {
    const originalTrialEndsAt = new Date(Date.now() + 5 * 86_400_000).toISOString();
    const [currentSub] = await db
      .insert(kiloclaw_subscriptions)
      .values({
        user_id: targetUser.id,
        plan: 'standard',
        status: 'active',
        payment_source: 'credits',
      })
      .returning();
    const [transferredSub] = await db
      .insert(kiloclaw_subscriptions)
      .values({
        user_id: targetUser.id,
        plan: 'trial',
        status: 'trialing',
        trial_started_at: new Date().toISOString(),
        trial_ends_at: originalTrialEndsAt,
        transferred_to_subscription_id: currentSub.id,
      })
      .returning();

    const caller = await createCallerForUser(adminUser.id);

    await expect(
      caller.admin.users.cancelKiloClawSubscription({
        userId: targetUser.id,
        subscriptionId: transferredSub.id,
        mode: 'immediate',
      })
    ).rejects.toThrow(
      'Transferred KiloClaw subscriptions are historical and cannot be modified. Edit the current subscription instead.'
    );

    const unchanged = await db.query.kiloclaw_subscriptions.findFirst({
      where: eq(kiloclaw_subscriptions.id, transferredSub.id),
    });
    expect(unchanged?.status).toBe('trialing');
    expectSameInstant(unchanged?.trial_ends_at, originalTrialEndsAt);

    const [changeLogCount] = await db
      .select({ value: count() })
      .from(kiloclaw_subscription_change_log)
      .where(eq(kiloclaw_subscription_change_log.subscription_id, transferredSub.id));
    expect(changeLogCount?.value).toBe(0);
  });

  it("rejects another user's subscription id", async () => {
    const otherUser = await insertTestUser({
      google_user_email: 'other-kiloclaw@example.com',
      google_user_name: 'Other User',
    });

    const [sub] = await db
      .insert(kiloclaw_subscriptions)
      .values({
        user_id: otherUser.id,
        plan: 'standard',
        status: 'active',
        payment_source: 'credits',
      })
      .returning();

    const caller = await createCallerForUser(adminUser.id);

    await expect(
      caller.admin.users.cancelKiloClawSubscription({
        userId: targetUser.id,
        subscriptionId: sub.id,
        mode: 'period_end',
      })
    ).rejects.toThrow('Subscription not found or does not belong to this user');
  });

  it('writes an admin audit log', async () => {
    const [sub] = await db
      .insert(kiloclaw_subscriptions)
      .values({
        user_id: targetUser.id,
        plan: 'standard',
        status: 'active',
        payment_source: 'credits',
      })
      .returning();

    const caller = await createCallerForUser(adminUser.id);
    await caller.admin.users.cancelKiloClawSubscription({
      userId: targetUser.id,
      subscriptionId: sub.id,
      mode: 'immediate',
    });

    const [auditLog] = await db
      .select()
      .from(kiloclaw_admin_audit_logs)
      .where(eq(kiloclaw_admin_audit_logs.target_user_id, targetUser.id));

    expect(auditLog).toEqual(
      expect.objectContaining({
        action: 'kiloclaw.subscription.admin_cancel',
        actor_id: adminUser.id,
        actor_email: adminUser.google_user_email,
        actor_name: adminUser.google_user_name,
        target_user_id: targetUser.id,
      })
    );
    expect(auditLog.metadata?.subscriptionId).toBe(sub.id);
    expect(auditLog.metadata?.mode).toBe('immediate');
    expect(auditLog.metadata?.previousStatus).toBe('active');
    expect(auditLog.metadata?.reconciliationStatus).toBe('updated');
    expect(auditLog.metadata?.stripeMutationAttempted).toBe(false);
  });

  it('period-end cancel after Stripe success updates local row and writes logs', async () => {
    const [sub] = await db
      .insert(kiloclaw_subscriptions)
      .values({
        user_id: targetUser.id,
        plan: 'standard',
        status: 'active',
        payment_source: 'credits',
        stripe_subscription_id: 'sub_admin_period_end',
        stripe_schedule_id: 'sched_admin_period_end',
        scheduled_plan: 'commit',
        scheduled_by: 'user',
      })
      .returning();

    jest.spyOn(stripeMock.subscriptions, 'retrieve').mockResolvedValue({ schedule: null } as never);

    const caller = await createCallerForUser(adminUser.id);
    await caller.admin.users.cancelKiloClawSubscription({
      userId: targetUser.id,
      subscriptionId: sub.id,
      mode: 'period_end',
    });

    expect(stripeMock.subscriptionSchedules.release).toHaveBeenCalledWith('sched_admin_period_end');
    expect(stripeMock.subscriptions.update).toHaveBeenCalledWith('sub_admin_period_end', {
      cancel_at_period_end: true,
    });

    const updated = await db.query.kiloclaw_subscriptions.findFirst({
      where: eq(kiloclaw_subscriptions.id, sub.id),
    });
    expect(updated?.cancel_at_period_end).toBe(true);
    expect(updated?.stripe_schedule_id).toBeNull();
    expect(updated?.scheduled_plan).toBeNull();
    expect(updated?.scheduled_by).toBeNull();

    const [changeLogCount] = await db
      .select({ value: count() })
      .from(kiloclaw_subscription_change_log)
      .where(eq(kiloclaw_subscription_change_log.subscription_id, sub.id));
    expect(changeLogCount?.value).toBe(1);

    const [auditLog] = await db
      .select()
      .from(kiloclaw_admin_audit_logs)
      .where(eq(kiloclaw_admin_audit_logs.target_user_id, targetUser.id));
    expect(auditLog.metadata?.reconciliationStatus).toBe('updated');
    expect(auditLog.metadata?.stripeMutationAttempted).toBe(true);
    expect(auditLog.metadata?.stripeSubscriptionId).toBe('sub_admin_period_end');
    expect(auditLog.metadata?.scheduleReleased).toBe(true);
    expect(auditLog.metadata?.scheduleIdToRelease).toBe('sched_admin_period_end');
  });

  it('throws and audits when local row is transferred after Stripe cancel succeeds', async () => {
    const [successorSub] = await db
      .insert(kiloclaw_subscriptions)
      .values({
        user_id: targetUser.id,
        plan: 'standard',
        status: 'active',
        payment_source: 'credits',
      })
      .returning();
    const [sub] = await db
      .insert(kiloclaw_subscriptions)
      .values({
        user_id: targetUser.id,
        plan: 'standard',
        status: 'active',
        payment_source: 'credits',
        stripe_subscription_id: 'sub_admin_race',
      })
      .returning();

    jest.spyOn(stripeMock.subscriptions, 'update').mockImplementation(async () => {
      await db
        .update(kiloclaw_subscriptions)
        .set({ transferred_to_subscription_id: successorSub.id })
        .where(eq(kiloclaw_subscriptions.id, sub.id));
      return {} as never;
    });

    const caller = await createCallerForUser(adminUser.id);
    await expect(
      caller.admin.users.cancelKiloClawSubscription({
        userId: targetUser.id,
        subscriptionId: sub.id,
        mode: 'period_end',
      })
    ).rejects.toThrow('Stripe cancellation was applied');

    const changed = await db.query.kiloclaw_subscriptions.findFirst({
      where: eq(kiloclaw_subscriptions.id, sub.id),
    });
    expect(changed?.transferred_to_subscription_id).toBe(successorSub.id);

    const [changeLogCount] = await db
      .select({ value: count() })
      .from(kiloclaw_subscription_change_log)
      .where(eq(kiloclaw_subscription_change_log.subscription_id, sub.id));
    expect(changeLogCount?.value).toBe(0);

    const [auditLog] = await db
      .select()
      .from(kiloclaw_admin_audit_logs)
      .where(eq(kiloclaw_admin_audit_logs.target_user_id, targetUser.id));
    expect(auditLog.metadata?.reconciliationStatus).toBe('local_row_changed_after_stripe');
    expect(auditLog.metadata?.stripeMutationAttempted).toBe(true);
    expect(auditLog.metadata?.localStateAtReconcile).toEqual(
      expect.objectContaining({ transferred_to_subscription_id: successorSub.id })
    );
  });

  it('throws and audits when local row is missing after Stripe cancel succeeds', async () => {
    const [sub] = await db
      .insert(kiloclaw_subscriptions)
      .values({
        user_id: targetUser.id,
        plan: 'standard',
        status: 'active',
        payment_source: 'credits',
        stripe_subscription_id: 'sub_admin_missing_row',
      })
      .returning();

    jest.spyOn(stripeMock.subscriptions, 'update').mockImplementation(async () => {
      await db.delete(kiloclaw_subscriptions).where(eq(kiloclaw_subscriptions.id, sub.id));
      return {} as never;
    });

    const caller = await createCallerForUser(adminUser.id);
    await expect(
      caller.admin.users.cancelKiloClawSubscription({
        userId: targetUser.id,
        subscriptionId: sub.id,
        mode: 'period_end',
      })
    ).rejects.toThrow('Stripe cancellation was applied');

    const [auditLog] = await db
      .select()
      .from(kiloclaw_admin_audit_logs)
      .where(eq(kiloclaw_admin_audit_logs.target_user_id, targetUser.id));
    expect(auditLog.metadata?.reconciliationStatus).toBe('local_row_changed_after_stripe');
    expect(auditLog.metadata?.stripeMutationAttempted).toBe(true);
    expect(auditLog.metadata?.localStateAtReconcile).toBeNull();
  });

  it('treats already reconciled local cancel state as idempotent after Stripe success', async () => {
    const [sub] = await db
      .insert(kiloclaw_subscriptions)
      .values({
        user_id: targetUser.id,
        plan: 'standard',
        status: 'active',
        payment_source: 'credits',
        stripe_subscription_id: 'sub_admin_idempotent',
      })
      .returning();

    jest.spyOn(stripeMock.subscriptions, 'update').mockImplementation(async () => {
      await db
        .update(kiloclaw_subscriptions)
        .set({ cancel_at_period_end: true })
        .where(eq(kiloclaw_subscriptions.id, sub.id));
      return {} as never;
    });

    const caller = await createCallerForUser(adminUser.id);
    await caller.admin.users.cancelKiloClawSubscription({
      userId: targetUser.id,
      subscriptionId: sub.id,
      mode: 'period_end',
    });

    const [changeLogCount] = await db
      .select({ value: count() })
      .from(kiloclaw_subscription_change_log)
      .where(eq(kiloclaw_subscription_change_log.subscription_id, sub.id));
    expect(changeLogCount?.value).toBe(0);

    const [auditLog] = await db
      .select()
      .from(kiloclaw_admin_audit_logs)
      .where(eq(kiloclaw_admin_audit_logs.target_user_id, targetUser.id));
    expect(auditLog.metadata?.reconciliationStatus).toBe('already_desired');
    expect(auditLog.metadata?.stripeMutationAttempted).toBe(true);
  });

  it('normalizes stale canceled local state after immediate Stripe cancel succeeds', async () => {
    const [sub] = await db
      .insert(kiloclaw_subscriptions)
      .values({
        user_id: targetUser.id,
        plan: 'standard',
        status: 'active',
        payment_source: 'credits',
        stripe_subscription_id: 'sub_admin_immediate_normalize',
        stripe_schedule_id: 'sched_admin_immediate_normalize',
        scheduled_plan: 'commit',
        scheduled_by: 'user',
      })
      .returning();

    jest.spyOn(stripeMock.subscriptions, 'cancel').mockImplementation(async () => {
      await db
        .update(kiloclaw_subscriptions)
        .set({
          status: 'canceled',
          cancel_at_period_end: true,
          stripe_schedule_id: 'sched_admin_immediate_normalize',
          scheduled_plan: 'commit',
          scheduled_by: 'user',
        })
        .where(eq(kiloclaw_subscriptions.id, sub.id));
      return {} as never;
    });

    const caller = await createCallerForUser(adminUser.id);
    await caller.admin.users.cancelKiloClawSubscription({
      userId: targetUser.id,
      subscriptionId: sub.id,
      mode: 'immediate',
    });

    const updated = await db.query.kiloclaw_subscriptions.findFirst({
      where: eq(kiloclaw_subscriptions.id, sub.id),
    });
    expect(updated?.status).toBe('canceled');
    expect(updated?.cancel_at_period_end).toBe(false);
    expect(updated?.stripe_schedule_id).toBeNull();
    expect(updated?.scheduled_plan).toBeNull();
    expect(updated?.scheduled_by).toBeNull();

    const [changeLogCount] = await db
      .select({ value: count() })
      .from(kiloclaw_subscription_change_log)
      .where(eq(kiloclaw_subscription_change_log.subscription_id, sub.id));
    expect(changeLogCount?.value).toBe(1);
  });

  it('throws and audits when period-end local row becomes canceled after Stripe success', async () => {
    const [sub] = await db
      .insert(kiloclaw_subscriptions)
      .values({
        user_id: targetUser.id,
        plan: 'standard',
        status: 'active',
        payment_source: 'credits',
        stripe_subscription_id: 'sub_admin_period_end_canceled_race',
      })
      .returning();

    jest.spyOn(stripeMock.subscriptions, 'update').mockImplementation(async () => {
      await db
        .update(kiloclaw_subscriptions)
        .set({ status: 'canceled', cancel_at_period_end: false })
        .where(eq(kiloclaw_subscriptions.id, sub.id));
      return {} as never;
    });

    const caller = await createCallerForUser(adminUser.id);
    await expect(
      caller.admin.users.cancelKiloClawSubscription({
        userId: targetUser.id,
        subscriptionId: sub.id,
        mode: 'period_end',
      })
    ).rejects.toThrow('Stripe cancellation was applied');

    const updated = await db.query.kiloclaw_subscriptions.findFirst({
      where: eq(kiloclaw_subscriptions.id, sub.id),
    });
    expect(updated?.status).toBe('canceled');
    expect(updated?.cancel_at_period_end).toBe(false);

    const [changeLogCount] = await db
      .select({ value: count() })
      .from(kiloclaw_subscription_change_log)
      .where(eq(kiloclaw_subscription_change_log.subscription_id, sub.id));
    expect(changeLogCount?.value).toBe(0);

    const [auditLog] = await db
      .select()
      .from(kiloclaw_admin_audit_logs)
      .where(eq(kiloclaw_admin_audit_logs.target_user_id, targetUser.id));
    expect(auditLog.metadata?.reconciliationStatus).toBe('local_row_changed_after_stripe');
    expect(auditLog.metadata?.localStateAtReconcile).toEqual(
      expect.objectContaining({ status: 'canceled', cancel_at_period_end: false })
    );
  });

  it('period-end cancel clears scheduled plan on pure-credit row', async () => {
    const [sub] = await db
      .insert(kiloclaw_subscriptions)
      .values({
        user_id: targetUser.id,
        plan: 'standard',
        status: 'active',
        scheduled_plan: 'commit',
        scheduled_by: 'user',
        payment_source: 'credits',
      })
      .returning();

    const caller = await createCallerForUser(adminUser.id);
    await caller.admin.users.cancelKiloClawSubscription({
      userId: targetUser.id,
      subscriptionId: sub.id,
      mode: 'period_end',
    });

    // DB cleared schedule fields
    const updated = await db.query.kiloclaw_subscriptions.findFirst({
      where: eq(kiloclaw_subscriptions.id, sub.id),
    });
    expect(updated?.stripe_schedule_id).toBeNull();
    expect(updated?.scheduled_plan).toBeNull();
    expect(updated?.scheduled_by).toBeNull();
    expect(updated?.cancel_at_period_end).toBe(true);
  });

  it('rejects period-end cancel on already-canceling subscription', async () => {
    const [sub] = await db
      .insert(kiloclaw_subscriptions)
      .values({
        user_id: targetUser.id,
        plan: 'standard',
        status: 'active',
        payment_source: 'credits',
        cancel_at_period_end: true,
      })
      .returning();

    const caller = await createCallerForUser(adminUser.id);

    await expect(
      caller.admin.users.cancelKiloClawSubscription({
        userId: targetUser.id,
        subscriptionId: sub.id,
        mode: 'period_end',
      })
    ).rejects.toThrow('already set to cancel at period end');
  });

  it('rejects period-end cancel on non-active subscription', async () => {
    const [sub] = await db
      .insert(kiloclaw_subscriptions)
      .values({
        user_id: targetUser.id,
        plan: 'standard',
        status: 'canceled',
        payment_source: 'credits',
      })
      .returning();

    const caller = await createCallerForUser(adminUser.id);

    await expect(
      caller.admin.users.cancelKiloClawSubscription({
        userId: targetUser.id,
        subscriptionId: sub.id,
        mode: 'period_end',
      })
    ).rejects.toThrow('Only active subscriptions can be canceled at period end');
  });

  it('immediately cancels a trialing subscription', async () => {
    const futureTrialEnd = new Date(Date.now() + 5 * 86_400_000).toISOString();
    const [sub] = await db
      .insert(kiloclaw_subscriptions)
      .values({
        user_id: targetUser.id,
        plan: 'trial',
        status: 'trialing',
        trial_started_at: new Date().toISOString(),
        trial_ends_at: futureTrialEnd,
      })
      .returning();

    const caller = await createCallerForUser(adminUser.id);
    const result = await caller.admin.users.cancelKiloClawSubscription({
      userId: targetUser.id,
      subscriptionId: sub.id,
      mode: 'immediate',
    });

    expect(result).toEqual({ success: true });

    const updated = await db.query.kiloclaw_subscriptions.findFirst({
      where: eq(kiloclaw_subscriptions.id, sub.id),
    });
    expect(updated?.status).toBe('canceled');
    expect(updated?.cancel_at_period_end).toBe(false);
    // trial_ends_at should be set to approximately now, not the future date
    expect(updated?.trial_ends_at).not.toBeNull();
    expect(new Date(updated!.trial_ends_at!).getTime()).toBeLessThanOrEqual(Date.now());
  });

  it('writes an audit log when canceling a trial', async () => {
    const futureTrialEnd = new Date(Date.now() + 5 * 86_400_000).toISOString();
    const [sub] = await db
      .insert(kiloclaw_subscriptions)
      .values({
        user_id: targetUser.id,
        plan: 'trial',
        status: 'trialing',
        trial_started_at: new Date().toISOString(),
        trial_ends_at: futureTrialEnd,
      })
      .returning();

    const caller = await createCallerForUser(adminUser.id);
    await caller.admin.users.cancelKiloClawSubscription({
      userId: targetUser.id,
      subscriptionId: sub.id,
      mode: 'immediate',
    });

    const [auditLog] = await db
      .select()
      .from(kiloclaw_admin_audit_logs)
      .where(eq(kiloclaw_admin_audit_logs.target_user_id, targetUser.id));

    expect(auditLog).toEqual(
      expect.objectContaining({
        action: 'kiloclaw.subscription.admin_cancel',
        actor_id: adminUser.id,
        target_user_id: targetUser.id,
      })
    );
    expect(auditLog.metadata?.subscriptionId).toBe(sub.id);
    expect(auditLog.metadata?.mode).toBe('immediate');
    expect(auditLog.metadata?.previousStatus).toBe('trialing');
  });

  it('rejects period-end cancel on a trialing subscription', async () => {
    const futureTrialEnd = new Date(Date.now() + 5 * 86_400_000).toISOString();
    const [sub] = await db
      .insert(kiloclaw_subscriptions)
      .values({
        user_id: targetUser.id,
        plan: 'trial',
        status: 'trialing',
        trial_started_at: new Date().toISOString(),
        trial_ends_at: futureTrialEnd,
      })
      .returning();

    const caller = await createCallerForUser(adminUser.id);

    await expect(
      caller.admin.users.cancelKiloClawSubscription({
        userId: targetUser.id,
        subscriptionId: sub.id,
        mode: 'period_end',
      })
    ).rejects.toThrow('Only active subscriptions can be canceled at period end');
  });
});
