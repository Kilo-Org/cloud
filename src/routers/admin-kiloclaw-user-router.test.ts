import { db, cleanupDbForTest } from '@/lib/drizzle';
import { KILOCLAW_BILLING_ENFORCEMENT } from '@/lib/config.server';
import { createCallerForUser } from '@/routers/test-utils';
import { insertTestUser } from '@/tests/helpers/user.helper';
import {
  kiloclaw_admin_audit_logs,
  kiloclaw_earlybird_purchases,
  kiloclaw_instances,
  kiloclaw_subscriptions,
} from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';
import type { User } from '@kilocode/db/schema';

let adminUser: User;
let targetUser: User;
const expectedAccessWithoutEntitlement = !KILOCLAW_BILLING_ENFORCEMENT;

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
      hasAccess: expectedAccessWithoutEntitlement,
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
    expect(result.hasAccess).toBe(expectedAccessWithoutEntitlement);
    expect(result.accessReason).toBeNull();
  });

  it('returns earlybird access when no subscription row exists', async () => {
    await db.insert(kiloclaw_earlybird_purchases).values({
      user_id: targetUser.id,
      amount_cents: 2500,
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
});

describe('admin.users.updateKiloClawTrialEndAt', () => {
  it('updates the trial end date and writes an admin audit log entry', async () => {
    const previousTrialEndsAt = '2026-03-20T23:59:59.000Z';
    const newTrialEndsAt = '2026-03-25T23:59:59.000Z';

    await db.insert(kiloclaw_subscriptions).values({
      user_id: targetUser.id,
      plan: 'trial',
      status: 'trialing',
      trial_started_at: '2026-03-13T12:00:00.000Z',
      trial_ends_at: previousTrialEndsAt,
    });

    const caller = await createCallerForUser(adminUser.id);
    const result = await caller.admin.users.updateKiloClawTrialEndAt({
      userId: targetUser.id,
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
        trial_ends_at: '2026-03-25T23:59:59.000Z',
      })
    ).rejects.toThrow('User not found');
  });

  it('rejects users without a KiloClaw subscription row', async () => {
    const caller = await createCallerForUser(adminUser.id);

    await expect(
      caller.admin.users.updateKiloClawTrialEndAt({
        userId: targetUser.id,
        trial_ends_at: '2026-03-25T23:59:59.000Z',
      })
    ).rejects.toThrow('No KiloClaw subscription found for this user');
  });

  it('rejects non-trialing and non-canceled subscription rows', async () => {
    await db.insert(kiloclaw_subscriptions).values({
      user_id: targetUser.id,
      plan: 'standard',
      status: 'active',
      stripe_subscription_id: 'sub_admin_kiloclaw_non_trial',
    });

    const caller = await createCallerForUser(adminUser.id);

    await expect(
      caller.admin.users.updateKiloClawTrialEndAt({
        userId: targetUser.id,
        trial_ends_at: '2026-03-25T23:59:59.000Z',
      })
    ).rejects.toThrow(
      'Only trialing or canceled KiloClaw subscriptions can have their trial end date edited'
    );
  });

  it('resets a canceled subscription to a new trial', async () => {
    const previousTrialEndsAt = '2026-03-15T23:59:59.000Z';
    const newTrialEndsAt = '2026-04-01T23:59:59.000Z';

    await db.insert(kiloclaw_subscriptions).values({
      user_id: targetUser.id,
      plan: 'trial',
      status: 'canceled',
      trial_started_at: '2026-03-08T12:00:00.000Z',
      trial_ends_at: previousTrialEndsAt,
      suspended_at: '2026-03-16T00:00:00.000Z',
      destruction_deadline: '2026-03-23T00:00:00.000Z',
    });

    const caller = await createCallerForUser(adminUser.id);
    const result = await caller.admin.users.updateKiloClawTrialEndAt({
      userId: targetUser.id,
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
  });
});
