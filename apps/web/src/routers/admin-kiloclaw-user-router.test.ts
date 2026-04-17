import { db, cleanupDbForTest } from '@/lib/drizzle';
import { createCallerForUser } from '@/routers/test-utils';
import { insertTestUser } from '@/tests/helpers/user.helper';
import {
  kiloclaw_admin_audit_logs,
  kiloclaw_earlybird_purchases,
  kiloclaw_subscription_change_log,
  kiloclaw_instances,
  kiloclaw_subscriptions,
} from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';
import type { User } from '@kilocode/db/schema';

let adminUser: User;
let targetUser: User;

function expectSameInstant(actual: string | null | undefined, expected: string) {
  expect(actual).not.toBeNull();
  expect(actual).toBeDefined();
  expect(new Date(actual as string).toISOString()).toBe(new Date(expected).toISOString());
}

beforeEach(async () => {
  await cleanupDbForTest();

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
    });
  });

  it('returns subscription access for active subscriptions', async () => {
    await db.insert(kiloclaw_subscriptions).values({
      user_id: targetUser.id,
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

  it('prefers an active subscription over an older canceled row', async () => {
    await db.insert(kiloclaw_subscriptions).values([
      {
        user_id: targetUser.id,
        plan: 'standard',
        status: 'canceled',
        stripe_subscription_id: 'sub_admin_kiloclaw_canceled',
        current_period_end: '2026-03-01T00:00:00.000Z',
      },
      {
        user_id: targetUser.id,
        plan: 'standard',
        status: 'active',
        stripe_subscription_id: 'sub_admin_kiloclaw_active_latest',
        current_period_end: '2026-05-01T00:00:00.000Z',
      },
    ]);

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

    await db.insert(kiloclaw_subscriptions).values({
      user_id: targetUser.id,
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

    await db.insert(kiloclaw_subscriptions).values({
      user_id: targetUser.id,
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

  it('returns earlybird access from legacy purchase row before backfill', async () => {
    await db.insert(kiloclaw_earlybird_purchases).values({
      user_id: targetUser.id,
      stripe_charge_id: `ch_${crypto.randomUUID().replace(/-/g, '')}`,
      amount_cents: 9900,
    });

    const caller = await createCallerForUser(adminUser.id);
    const result = await caller.admin.users.getKiloClawState({ userId: targetUser.id });

    expect(result.subscription).toBeNull();
    expect(result.hasAccess).toBe(true);
    expect(result.accessReason).toBe('earlybird');
    expect(result.earlybird).toEqual(
      expect.objectContaining({
        purchased: true,
        expiresAt: expect.any(String),
        daysRemaining: expect.any(Number),
      })
    );
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
