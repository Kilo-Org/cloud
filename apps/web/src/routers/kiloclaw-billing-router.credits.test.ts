import {
  PRE_COMMIT_CUTOFF_TIME,
  createCallerForUser,
  createKiloclawInstance,
  insertPersonalSubscriptionFixture,
  kiloclawInternalClientMock,
  seedDeliveredImpactSignupEvent,
  setTestSystemTime,
  stripeMock,
  user,
} from './kiloclaw-billing-router.test-harness';
import { describe, expect, it } from '@jest/globals';
import { db } from '@kilocode/web-shared/lib/drizzle';
import {
  kiloclaw_subscriptions,
  kiloclaw_instances,
  kiloclaw_subscription_change_log,
  kilocode_users,
  credit_transactions,
  kilo_pass_store_purchases,
  kilo_pass_subscriptions,
  user_affiliate_events,
} from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';
import { sandboxIdFromUserId } from '@kilocode/worker-utils/sandbox-id';
import type Stripe from 'stripe';
import {
  KiloPassTier,
  KiloPassCadence,
  KiloPassPaymentProvider,
} from '@kilocode/web-shared/lib/kilo-pass/enums';
import { differenceInCalendarMonths } from 'date-fns';
import { CURRENT_KILOCLAW_PRICE_VERSION, LEGACY_KILOCLAW_PRICE_VERSION } from '@kilocode/db';

// ── Credit Enrollment ──────────────────────────────────────────────────────

describe('enrollWithCredits', () => {
  async function giveUserCredits(userId: string, microdollars: number) {
    await db
      .update(kilocode_users)
      .set({ total_microdollars_acquired: microdollars })
      .where(eq(kilocode_users.id, userId));
  }

  async function createInstance(userId: string) {
    const [instance] = await db
      .insert(kiloclaw_instances)
      .values({
        user_id: userId,
        sandbox_id: sandboxIdFromUserId(userId),
      })
      .returning();
    return instance;
  }

  async function createCreditEnrollmentAnchor(userId: string) {
    const instance = await createInstance(userId);
    await db.insert(kiloclaw_subscriptions).values({
      user_id: userId,
      instance_id: instance.id,
      plan: 'trial',
      status: 'trialing',
      trial_started_at: new Date().toISOString(),
      trial_ends_at: new Date(Date.now() + 7 * 86_400_000).toISOString(),
    });
    return instance;
  }

  it('rejects enrollment funded only by expired principal without a prior balance read', async () => {
    await createCreditEnrollmentAnchor(user.id);
    await giveUserCredits(user.id, 60_000_000);
    const expiry = new Date(Date.now() - 60_000).toISOString();
    await db.insert(credit_transactions).values({
      kilo_user_id: user.id,
      amount_microdollars: 60_000_000,
      is_free: false,
      expiry_date: expiry,
      expiration_baseline_microdollars_used: 0,
      original_baseline_microdollars_used: 0,
      description: 'Expired KiloClaw enrollment funds',
    });
    await db
      .update(kilocode_users)
      .set({ next_credit_expiration_at: expiry })
      .where(eq(kilocode_users.id, user.id));

    const caller = await createCallerForUser(user.id);
    await expect(caller.kiloclaw.enrollWithCredits({ plan: 'standard' })).rejects.toThrow(
      'Insufficient credit balance'
    );
    const payer = await db.query.kilocode_users.findFirst({
      where: eq(kilocode_users.id, user.id),
    });
    expect(payer?.microdollars_used).toBe(0);
  });

  it('clears destruction fields and records resume retry state when credit enrollment activates a suspended trial', async () => {
    const instance = await createInstance(user.id);
    await giveUserCredits(user.id, 60_000_000);
    const now = new Date();

    await db.insert(kiloclaw_subscriptions).values({
      user_id: user.id,
      instance_id: instance.id,
      plan: 'trial',
      status: 'trialing',
      trial_started_at: new Date(now.getTime() - 17 * 86_400_000).toISOString(),
      trial_ends_at: new Date(now.getTime() - 10 * 86_400_000).toISOString(),
      suspended_at: new Date(now.getTime() - 10 * 86_400_000).toISOString(),
      destruction_deadline: new Date(now.getTime() - 3 * 86_400_000).toISOString(),
      auto_resume_requested_at: new Date(now.getTime() - 2 * 86_400_000).toISOString(),
      auto_resume_retry_after: new Date(now.getTime() - 1 * 86_400_000).toISOString(),
      auto_resume_attempt_count: 4,
    });

    const caller = await createCallerForUser(user.id);
    const result = await caller.kiloclaw.enrollWithCredits({
      plan: 'standard',
    });

    expect(result).toEqual({ success: true });

    const [subscription] = await db
      .select()
      .from(kiloclaw_subscriptions)
      .where(eq(kiloclaw_subscriptions.user_id, user.id))
      .limit(1);

    expect(subscription).toEqual(
      expect.objectContaining({
        status: 'active',
        payment_source: 'credits',
        suspended_at: null,
        destruction_deadline: null,
        auto_resume_attempt_count: 1,
      })
    );
    expect(subscription.auto_resume_requested_at).toEqual(expect.any(String));
    expect(subscription.auto_resume_retry_after).toEqual(expect.any(String));
    expect(kiloclawInternalClientMock.__startAsyncMock).toHaveBeenCalledTimes(1);

    const logs = await db
      .select()
      .from(kiloclaw_subscription_change_log)
      .where(eq(kiloclaw_subscription_change_log.subscription_id, subscription.id));
    expect(logs[0]?.after_state).toEqual(
      expect.objectContaining({
        status: 'active',
        suspended_at: null,
        destruction_deadline: null,
        auto_resume_requested_at: null,
        auto_resume_retry_after: null,
        auto_resume_attempt_count: 0,
      })
    );
  });

  it('keeps credit-enrolled subscription retryable when auto-resume request fails', async () => {
    kiloclawInternalClientMock.__startAsyncMock.mockRejectedValueOnce(new Error('start failed'));
    const instance = await createInstance(user.id);
    await giveUserCredits(user.id, 60_000_000);
    const now = new Date();

    await db.insert(kiloclaw_subscriptions).values({
      user_id: user.id,
      instance_id: instance.id,
      plan: 'trial',
      status: 'trialing',
      trial_started_at: new Date(now.getTime() - 17 * 86_400_000).toISOString(),
      trial_ends_at: new Date(now.getTime() - 10 * 86_400_000).toISOString(),
      suspended_at: new Date(now.getTime() - 10 * 86_400_000).toISOString(),
      destruction_deadline: new Date(now.getTime() - 3 * 86_400_000).toISOString(),
      auto_resume_requested_at: new Date(now.getTime() - 2 * 86_400_000).toISOString(),
      auto_resume_retry_after: new Date(now.getTime() - 1 * 86_400_000).toISOString(),
      auto_resume_attempt_count: 4,
    });

    const caller = await createCallerForUser(user.id);
    const result = await caller.kiloclaw.enrollWithCredits({
      plan: 'standard',
    });

    expect(result).toEqual({ success: true });

    const [subscription] = await db
      .select()
      .from(kiloclaw_subscriptions)
      .where(eq(kiloclaw_subscriptions.user_id, user.id))
      .limit(1);

    expect(subscription).toEqual(
      expect.objectContaining({
        status: 'active',
        payment_source: 'credits',
        suspended_at: null,
        destruction_deadline: null,
        auto_resume_attempt_count: 1,
      })
    );
    expect(subscription.auto_resume_requested_at).toEqual(expect.any(String));
    expect(subscription.auto_resume_retry_after).toEqual(expect.any(String));
  });

  it('enrolls with credits for standard plan at intro price for first-time subscriber', async () => {
    const instance = await createInstance(user.id);
    await giveUserCredits(user.id, 50_000_000); // $50

    // Create a trialing subscription — trial does not count as a prior paid sub,
    // so the user qualifies for the $4 first-month discount.
    await db.insert(kiloclaw_subscriptions).values({
      user_id: user.id,
      instance_id: instance.id,
      plan: 'trial',
      status: 'trialing',
      trial_started_at: new Date().toISOString(),
      trial_ends_at: new Date(Date.now() + 7 * 86_400_000).toISOString(),
    });

    const caller = await createCallerForUser(user.id);
    const result = await caller.kiloclaw.enrollWithCredits({
      plan: 'standard',
    });

    expect(result).toEqual({ success: true });

    const [sub] = await db
      .select()
      .from(kiloclaw_subscriptions)
      .where(eq(kiloclaw_subscriptions.user_id, user.id))
      .limit(1);

    expect(sub.status).toBe('active');
    expect(sub.payment_source).toBe('credits');
    expect(sub.plan).toBe('standard');
    expect(sub.kiloclaw_price_version).toBe(LEGACY_KILOCLAW_PRICE_VERSION);
    expect(sub.stripe_subscription_id).toBeNull();
    expect(sub.credit_renewal_at).not.toBeNull();
    expect(sub.cancel_at_period_end).toBe(false);
    // Trial dates are preserved for historical visibility in billing status / admin views
    expect(sub.trial_started_at).not.toBeNull();
    expect(sub.trial_ends_at).not.toBeNull();

    // Verify credit deduction at intro price ($4, not $9)
    const txns = await db
      .select()
      .from(credit_transactions)
      .where(eq(credit_transactions.kilo_user_id, user.id));

    const deduction = txns.find(t => t.amount_microdollars < 0);
    expect(deduction).toBeDefined();
    expect(deduction!.amount_microdollars).toBe(-4_000_000);
    expect(deduction!.credit_category).toContain('kiloclaw-subscription:');

    // Verify credit spend recorded at intro amount
    const [updatedUser] = await db
      .select({
        acquired: kilocode_users.total_microdollars_acquired,
        used: kilocode_users.microdollars_used,
      })
      .from(kilocode_users)
      .where(eq(kilocode_users.id, user.id))
      .limit(1);

    expect(updatedUser.acquired).toBe(50_000_000);
    expect(updatedUser.used).toBe(4_000_000);

    const logs = await db
      .select()
      .from(kiloclaw_subscription_change_log)
      .where(eq(kiloclaw_subscription_change_log.subscription_id, sub.id));
    expect(logs).toHaveLength(1);
    expect(logs[0]).toEqual(
      expect.objectContaining({
        actor_type: 'user',
        actor_id: user.id,
        action: 'payment_source_changed',
        reason: 'credit_enrollment',
      })
    );
    expect(logs[0]?.before_state).toEqual(
      expect.objectContaining({
        plan: 'trial',
        status: 'trialing',
      })
    );
    expect(logs[0]?.after_state).toEqual(
      expect.objectContaining({
        payment_source: 'credits',
        plan: 'standard',
        status: 'active',
      })
    );
  });

  it('charges current standard pricing without intro discount for current trial enrollment', async () => {
    const instance = await createInstance(user.id);
    await giveUserCredits(user.id, 60_000_000);

    await db.insert(kiloclaw_subscriptions).values({
      user_id: user.id,
      instance_id: instance.id,
      plan: 'trial',
      status: 'trialing',
      trial_started_at: new Date().toISOString(),
      trial_ends_at: new Date(Date.now() + 86_400_000).toISOString(),
      kiloclaw_price_version: CURRENT_KILOCLAW_PRICE_VERSION,
    });

    const caller = await createCallerForUser(user.id);
    const result = await caller.kiloclaw.enrollWithCredits({
      plan: 'standard',
    });

    expect(result).toEqual({ success: true });

    const [sub] = await db
      .select()
      .from(kiloclaw_subscriptions)
      .where(eq(kiloclaw_subscriptions.user_id, user.id))
      .limit(1);
    expect(sub.kiloclaw_price_version).toBe(CURRENT_KILOCLAW_PRICE_VERSION);

    const txns = await db
      .select()
      .from(credit_transactions)
      .where(eq(credit_transactions.kilo_user_id, user.id));
    const deduction = txns.find(t => t.amount_microdollars < 0);
    expect(deduction?.amount_microdollars).toBe(-55_000_000);

    const [updatedUser] = await db
      .select({ used: kilocode_users.microdollars_used })
      .from(kilocode_users)
      .where(eq(kilocode_users.id, user.id))
      .limit(1);
    expect(updatedUser.used).toBe(55_000_000);
  });

  it('auto-enrolls with settled Kilo Pass credits through the versioned credit enrollment path', async () => {
    const instance = await createInstance(user.id);
    await giveUserCredits(user.id, 60_000_000);

    await db.insert(kiloclaw_subscriptions).values({
      user_id: user.id,
      instance_id: instance.id,
      plan: 'trial',
      status: 'trialing',
      trial_started_at: new Date().toISOString(),
      trial_ends_at: new Date(Date.now() + 86_400_000).toISOString(),
      kiloclaw_price_version: CURRENT_KILOCLAW_PRICE_VERSION,
    });
    const kiloPassSubscriptionId = `kp-auto-enroll-${crypto.randomUUID()}`;
    await db.insert(kilo_pass_subscriptions).values({
      kilo_user_id: user.id,
      provider_subscription_id: kiloPassSubscriptionId,
      stripe_subscription_id: kiloPassSubscriptionId,
      tier: KiloPassTier.Tier199,
      cadence: KiloPassCadence.Monthly,
      status: 'active',
      cancel_at_period_end: false,
      started_at: new Date().toISOString(),
      current_streak_months: 1,
      next_yearly_issue_at: null,
    });

    const caller = await createCallerForUser(user.id);
    const result = await caller.kiloclaw.enrollWithCredits({
      plan: 'standard',
    });

    expect(result).toEqual({ success: true });

    const [sub] = await db
      .select()
      .from(kiloclaw_subscriptions)
      .where(eq(kiloclaw_subscriptions.user_id, user.id))
      .limit(1);
    expect(sub.kiloclaw_price_version).toBe(CURRENT_KILOCLAW_PRICE_VERSION);
    expect(sub.payment_source).toBe('credits');
    expect(sub.plan).toBe('standard');

    const txns = await db
      .select()
      .from(credit_transactions)
      .where(eq(credit_transactions.kilo_user_id, user.id));
    const deduction = txns.find(t => t.amount_microdollars < 0);
    expect(deduction?.amount_microdollars).toBe(-55_000_000);
  });

  it('rejects credit enrollment without an existing personal subscription', async () => {
    const instance = await createInstance(user.id);
    await giveUserCredits(user.id, 60_000_000);

    const caller = await createCallerForUser(user.id);
    await expect(
      caller.kiloclaw.enrollWithCredits({
        plan: 'standard',
        instanceId: instance.id,
      })
    ).rejects.toThrow('A current KiloClaw subscription is required to provision an instance.');

    const subscriptions = await db
      .select()
      .from(kiloclaw_subscriptions)
      .where(eq(kiloclaw_subscriptions.user_id, user.id));
    expect(subscriptions).toHaveLength(0);

    const transactions = await db
      .select()
      .from(credit_transactions)
      .where(eq(credit_transactions.kilo_user_id, user.id));
    expect(transactions).toHaveLength(0);
  });

  it('rejects current standard enrollment when balance only covers legacy pricing', async () => {
    const instance = await createInstance(user.id);
    await giveUserCredits(user.id, 50_000_000);

    await db.insert(kiloclaw_subscriptions).values({
      user_id: user.id,
      instance_id: instance.id,
      plan: 'trial',
      status: 'trialing',
      trial_started_at: new Date().toISOString(),
      trial_ends_at: new Date(Date.now() + 86_400_000).toISOString(),
      kiloclaw_price_version: CURRENT_KILOCLAW_PRICE_VERSION,
    });

    const caller = await createCallerForUser(user.id);
    await expect(caller.kiloclaw.enrollWithCredits({ plan: 'standard' })).rejects.toThrow(
      'Insufficient credit balance'
    );
  });

  it('charges legacy recurring standard for live legacy trial with prior paid history', async () => {
    const priorInstance = await createInstance(user.id);
    await db
      .update(kiloclaw_instances)
      .set({ destroyed_at: new Date().toISOString() })
      .where(eq(kiloclaw_instances.id, priorInstance.id));
    const liveTrialInstance = await createInstance(user.id);
    await giveUserCredits(user.id, 10_000_000);
    await db.insert(kiloclaw_subscriptions).values({
      user_id: user.id,
      instance_id: priorInstance.id,
      payment_source: 'credits',
      plan: 'standard',
      status: 'canceled',
      cancel_at_period_end: false,
      current_period_start: '2026-04-01T00:00:00.000Z',
      current_period_end: '2026-05-01T00:00:00.000Z',
      credit_renewal_at: '2026-05-01T00:00:00.000Z',
      kiloclaw_price_version: LEGACY_KILOCLAW_PRICE_VERSION,
    });
    await db.insert(kiloclaw_subscriptions).values({
      user_id: user.id,
      instance_id: liveTrialInstance.id,
      plan: 'trial',
      status: 'trialing',
      trial_started_at: new Date().toISOString(),
      trial_ends_at: new Date(Date.now() + 7 * 86_400_000).toISOString(),
      kiloclaw_price_version: LEGACY_KILOCLAW_PRICE_VERSION,
    });

    const caller = await createCallerForUser(user.id);
    const result = await caller.kiloclaw.enrollWithCredits({
      plan: 'standard',
      instanceId: liveTrialInstance.id,
    });

    expect(result).toEqual({ success: true });

    const txns = await db
      .select()
      .from(credit_transactions)
      .where(eq(credit_transactions.kilo_user_id, user.id));
    const deduction = txns.find(t => t.amount_microdollars < 0);
    expect(deduction?.amount_microdollars).toBe(-9_000_000);

    const [sub] = await db
      .select()
      .from(kiloclaw_subscriptions)
      .where(eq(kiloclaw_subscriptions.instance_id, liveTrialInstance.id))
      .limit(1);
    expect(sub.kiloclaw_price_version).toBe(LEGACY_KILOCLAW_PRICE_VERSION);
  });

  it('enrolls with credits for commit plan when balance sufficient', async () => {
    setTestSystemTime(PRE_COMMIT_CUTOFF_TIME);
    await createCreditEnrollmentAnchor(user.id);
    await giveUserCredits(user.id, 50_000_000); // $50

    const caller = await createCallerForUser(user.id);
    const result = await caller.kiloclaw.enrollWithCredits({ plan: 'commit' });

    expect(result).toEqual({ success: true });

    const [sub] = await db
      .select()
      .from(kiloclaw_subscriptions)
      .where(eq(kiloclaw_subscriptions.user_id, user.id))
      .limit(1);

    expect(sub.plan).toBe('commit');
    expect(sub.status).toBe('active');
    expect(sub.payment_source).toBe('credits');
    expect(sub.commit_ends_at).not.toBeNull();

    // commit_ends_at should be 6 calendar months from now.
    const commitEnd = new Date(sub.commit_ends_at!);
    expect(differenceInCalendarMonths(commitEnd, new Date())).toBe(6);
  });

  it('charges current commit pricing for current trial enrollment', async () => {
    setTestSystemTime(PRE_COMMIT_CUTOFF_TIME);
    const instance = await createInstance(user.id);
    await giveUserCredits(user.id, 310_000_000);

    await db.insert(kiloclaw_subscriptions).values({
      user_id: user.id,
      instance_id: instance.id,
      plan: 'trial',
      status: 'trialing',
      trial_started_at: new Date().toISOString(),
      trial_ends_at: new Date(Date.now() + 86_400_000).toISOString(),
      kiloclaw_price_version: CURRENT_KILOCLAW_PRICE_VERSION,
    });

    const caller = await createCallerForUser(user.id);
    const result = await caller.kiloclaw.enrollWithCredits({ plan: 'commit' });

    expect(result).toEqual({ success: true });

    const [sub] = await db
      .select()
      .from(kiloclaw_subscriptions)
      .where(eq(kiloclaw_subscriptions.user_id, user.id))
      .limit(1);
    expect(sub.plan).toBe('commit');
    expect(sub.kiloclaw_price_version).toBe(CURRENT_KILOCLAW_PRICE_VERSION);

    const txns = await db
      .select()
      .from(credit_transactions)
      .where(eq(credit_transactions.kilo_user_id, user.id));
    const deduction = txns.find(t => t.amount_microdollars < 0);
    expect(deduction?.amount_microdollars).toBe(-306_000_000);
  });

  it('rejects enrollment when balance is insufficient', async () => {
    setTestSystemTime(PRE_COMMIT_CUTOFF_TIME);
    await createCreditEnrollmentAnchor(user.id);
    await giveUserCredits(user.id, 5_000_000); // $5 — not enough for commit ($48)

    const caller = await createCallerForUser(user.id);
    await expect(caller.kiloclaw.enrollWithCredits({ plan: 'commit' })).rejects.toThrow(
      'Insufficient credit balance'
    );
  });

  it('rejects enrollment when subscription is active', async () => {
    const instance = await createInstance(user.id);
    await giveUserCredits(user.id, 50_000_000);

    await db.insert(kiloclaw_subscriptions).values({
      user_id: user.id,
      instance_id: instance.id,
      payment_source: 'credits',
      plan: 'standard',
      status: 'active',
      current_period_start: new Date().toISOString(),
      current_period_end: new Date(Date.now() + 30 * 86_400_000).toISOString(),
      credit_renewal_at: new Date(Date.now() + 30 * 86_400_000).toISOString(),
      cancel_at_period_end: false,
    });

    const caller = await createCallerForUser(user.id);
    await expect(caller.kiloclaw.enrollWithCredits({ plan: 'standard' })).rejects.toThrow(
      'active subscription already exists'
    );
  });

  it('rejects a destroyed billing anchor before direct credit enrollment', async () => {
    const instance = await createInstance(user.id);
    await giveUserCredits(user.id, 50_000_000);
    const now = new Date();
    const periodKey = now.toISOString().slice(0, 7);

    await db.insert(kiloclaw_subscriptions).values({
      user_id: user.id,
      instance_id: instance.id,
      payment_source: 'credits',
      plan: 'standard',
      status: 'active',
      current_period_start: now.toISOString(),
      current_period_end: new Date(now.getTime() + 30 * 86_400_000).toISOString(),
      credit_renewal_at: new Date(now.getTime() + 30 * 86_400_000).toISOString(),
      cancel_at_period_end: false,
    });
    await db.insert(credit_transactions).values({
      kilo_user_id: user.id,
      amount_microdollars: -4_000_000,
      is_free: false,
      description: 'KiloClaw standard enrollment',
      credit_category: `kiloclaw-subscription:${instance.id}:${periodKey}`,
      check_category_uniqueness: true,
      original_baseline_microdollars_used: 0,
    });
    await db
      .update(kiloclaw_instances)
      .set({ destroyed_at: new Date(now.getTime() + 60_000).toISOString() })
      .where(eq(kiloclaw_instances.id, instance.id));

    const caller = await createCallerForUser(user.id);
    await expect(caller.kiloclaw.enrollWithCredits({ plan: 'standard' })).rejects.toThrow(
      'Reprovision KiloClaw before enrolling hosting with credits.'
    );
  });

  it('does not reprovision a destroyed canceled Standard subscription', async () => {
    const destroyedInstance = await createInstance(user.id);
    await db
      .update(kiloclaw_instances)
      .set({ destroyed_at: '2026-06-30T00:00:00.000Z' })
      .where(eq(kiloclaw_instances.id, destroyedInstance.id));
    await db.insert(kiloclaw_subscriptions).values({
      user_id: user.id,
      instance_id: destroyedInstance.id,
      payment_source: 'credits',
      plan: 'standard',
      status: 'canceled',
      kiloclaw_price_version: CURRENT_KILOCLAW_PRICE_VERSION,
    });

    const caller = await createCallerForUser(user.id);
    await expect(caller.kiloclaw.getBillingStatus()).resolves.toMatchObject({
      creditReprovisionRecovery: { eligible: false },
    });
    await expect(
      caller.kiloclaw.reprovisionAndEnrollWithCredits({ plan: 'standard' })
    ).rejects.toThrow('Credit-funded reprovision recovery is not available');
    expect(kiloclawInternalClientMock.__provisionMock).not.toHaveBeenCalled();
  });

  it('rejects canceled legacy credit enrollment without rewriting historical lineage', async () => {
    const instance = await createInstance(user.id);
    await giveUserCredits(user.id, 60_000_000);

    await db.insert(kiloclaw_subscriptions).values({
      user_id: user.id,
      instance_id: instance.id,
      payment_source: 'credits',
      plan: 'standard',
      status: 'canceled',
      kiloclaw_price_version: LEGACY_KILOCLAW_PRICE_VERSION,
      stripe_subscription_id: 'sub_deleted_legacy_direct_enrollment',
      cancel_at_period_end: false,
    });

    const caller = await createCallerForUser(user.id);
    await expect(caller.kiloclaw.enrollWithCredits({ plan: 'standard' })).rejects.toThrow(
      'Canceled legacy KiloClaw history requires reprovisioning before credit enrollment.'
    );

    const [sub] = await db
      .select()
      .from(kiloclaw_subscriptions)
      .where(eq(kiloclaw_subscriptions.user_id, user.id))
      .limit(1);

    expect(sub).toEqual(
      expect.objectContaining({
        status: 'canceled',
        payment_source: 'credits',
        kiloclaw_price_version: LEGACY_KILOCLAW_PRICE_VERSION,
        stripe_subscription_id: 'sub_deleted_legacy_direct_enrollment',
      })
    );

    const txns = await db
      .select()
      .from(credit_transactions)
      .where(eq(credit_transactions.kilo_user_id, user.id));
    expect(txns).toHaveLength(0);

    const [updatedUser] = await db
      .select({ used: kilocode_users.microdollars_used })
      .from(kilocode_users)
      .where(eq(kilocode_users.id, user.id))
      .limit(1);
    expect(updatedUser.used).toBe(0);
  });

  it('allows enrollment when subscription is trialing', async () => {
    const instance = await createInstance(user.id);
    await giveUserCredits(user.id, 50_000_000);
    await db
      .update(kiloclaw_instances)
      .set({ inactive_trial_stopped_at: '2026-04-20T12:00:00.000Z' })
      .where(eq(kiloclaw_instances.id, instance.id));

    await db.insert(kiloclaw_subscriptions).values({
      user_id: user.id,
      instance_id: instance.id,
      plan: 'trial',
      status: 'trialing',
      trial_started_at: new Date().toISOString(),
      trial_ends_at: new Date(Date.now() + 7 * 86_400_000).toISOString(),
    });

    const caller = await createCallerForUser(user.id);
    const result = await caller.kiloclaw.enrollWithCredits({
      plan: 'standard',
    });

    expect(result).toEqual({ success: true });

    const [sub] = await db
      .select()
      .from(kiloclaw_subscriptions)
      .where(eq(kiloclaw_subscriptions.user_id, user.id))
      .limit(1);

    expect(sub.status).toBe('active');
    expect(sub.plan).toBe('standard');
    // Trial dates are preserved for historical visibility
    expect(sub.trial_started_at).not.toBeNull();
    expect(sub.trial_ends_at).not.toBeNull();

    const [updatedInstance] = await db
      .select({ inactive: kiloclaw_instances.inactive_trial_stopped_at })
      .from(kiloclaw_instances)
      .where(eq(kiloclaw_instances.id, instance.id))
      .limit(1);

    expect(updatedInstance?.inactive).toBeNull();
  });

  it('enqueues trial_end and sale affiliate events for attributed trial-to-credit conversion', async () => {
    const instance = await createInstance(user.id);
    await giveUserCredits(user.id, 50_000_000);
    await seedDeliveredImpactSignupEvent(user.id, user.google_user_email);

    await db.insert(kiloclaw_subscriptions).values({
      user_id: user.id,
      instance_id: instance.id,
      plan: 'trial',
      status: 'trialing',
      trial_started_at: new Date().toISOString(),
      trial_ends_at: new Date(Date.now() + 7 * 86_400_000).toISOString(),
    });

    const caller = await createCallerForUser(user.id);
    await caller.kiloclaw.enrollWithCredits({ plan: 'standard' });

    const events = await db
      .select()
      .from(user_affiliate_events)
      .where(eq(user_affiliate_events.user_id, user.id));

    expect(events.map(event => event.event_type).sort()).toEqual(['sale', 'signup', 'trial_end']);
    expect(events.find(event => event.event_type === 'trial_end')).toEqual(
      expect.objectContaining({
        delivery_state: 'queued',
      })
    );
    expect(events.find(event => event.event_type === 'sale')).toEqual(
      expect.objectContaining({
        delivery_state: 'queued',
        payload_json: expect.objectContaining({
          amount: 4,
          currencyCode: 'usd',
          itemCategory: 'kiloclaw-standard-2026-03-19',
          itemName: 'KiloClaw Standard Plan',
          itemSku: 'price_standard_intro',
          orderId: expect.stringContaining(`kiloclaw-subscription:${instance.id}:`),
        }),
      })
    );
  });

  it('enqueues only sale affiliate events for attributed direct credit enrollment', async () => {
    setTestSystemTime(PRE_COMMIT_CUTOFF_TIME);
    const instance = await createInstance(user.id);
    await giveUserCredits(user.id, 310_000_000);
    await seedDeliveredImpactSignupEvent(user.id, user.google_user_email);
    await db.insert(kiloclaw_subscriptions).values({
      user_id: user.id,
      instance_id: instance.id,
      plan: 'standard',
      status: 'canceled',
      kiloclaw_price_version: CURRENT_KILOCLAW_PRICE_VERSION,
      current_period_end: '2026-04-01T00:00:00.000Z',
    });

    const caller = await createCallerForUser(user.id);
    await caller.kiloclaw.enrollWithCredits({ plan: 'commit' });

    const events = await db
      .select()
      .from(user_affiliate_events)
      .where(eq(user_affiliate_events.user_id, user.id));

    expect(events.map(event => event.event_type).sort()).toEqual(['sale', 'signup']);
    expect(events.find(event => event.event_type === 'sale')).toEqual(
      expect.objectContaining({
        delivery_state: 'queued',
        payload_json: expect.objectContaining({
          amount: 306,
          currencyCode: 'usd',
          itemCategory: 'kiloclaw-commit-2026-05-10',
          itemName: 'KiloClaw Commit Plan',
          itemSku: 'price_test_kiloclaw',
          orderId: expect.stringContaining(`kiloclaw-subscription-commit:${instance.id}:`),
        }),
      })
    );
  });

  it('does not enqueue affiliate child events for non-attributed credit enrollment', async () => {
    await createCreditEnrollmentAnchor(user.id);
    await giveUserCredits(user.id, 50_000_000);

    const caller = await createCallerForUser(user.id);
    await caller.kiloclaw.enrollWithCredits({ plan: 'standard' });

    const events = await db
      .select()
      .from(user_affiliate_events)
      .where(eq(user_affiliate_events.user_id, user.id));

    expect(events).toHaveLength(0);
  });

  it('charges current recurring standard price after canceled trial history', async () => {
    const instance = await createInstance(user.id);
    await giveUserCredits(user.id, 60_000_000);

    // Canceled trial-only history cannot create fresh current intro eligibility.
    await db.insert(kiloclaw_subscriptions).values({
      user_id: user.id,
      instance_id: instance.id,
      plan: 'trial',
      status: 'canceled',
      kiloclaw_price_version: CURRENT_KILOCLAW_PRICE_VERSION,
      cancel_at_period_end: false,
    });

    const caller = await createCallerForUser(user.id);
    const result = await caller.kiloclaw.enrollWithCredits({
      plan: 'standard',
    });

    expect(result).toEqual({ success: true });

    const txns = await db
      .select()
      .from(credit_transactions)
      .where(eq(credit_transactions.kilo_user_id, user.id));

    const deduction = txns.find(t => t.amount_microdollars < 0);
    expect(deduction!.amount_microdollars).toBe(-55_000_000);

    const [sub] = await db
      .select()
      .from(kiloclaw_subscriptions)
      .where(eq(kiloclaw_subscriptions.user_id, user.id))
      .limit(1);
    expect(sub.kiloclaw_price_version).toBe(CURRENT_KILOCLAW_PRICE_VERSION);
  });

  it('succeeds with balance between intro and full price for first-time subscriber', async () => {
    await createCreditEnrollmentAnchor(user.id);
    await giveUserCredits(user.id, 5_000_000); // $5 — enough for $4 intro, not enough for $9

    const caller = await createCallerForUser(user.id);
    const result = await caller.kiloclaw.enrollWithCredits({
      plan: 'standard',
    });

    expect(result).toEqual({ success: true });

    const txns = await db
      .select()
      .from(credit_transactions)
      .where(eq(credit_transactions.kilo_user_id, user.id));

    const deduction = txns.find(t => t.amount_microdollars < 0);
    expect(deduction!.amount_microdollars).toBe(-4_000_000);
  });

  it('rejects first-time standard enrollment when balance insufficient for intro price', async () => {
    await createCreditEnrollmentAnchor(user.id);
    await giveUserCredits(user.id, 3_000_000); // $3 — not enough for $4 intro

    const caller = await createCallerForUser(user.id);
    await expect(caller.kiloclaw.enrollWithCredits({ plan: 'standard' })).rejects.toThrow(
      'Insufficient credit balance'
    );
  });

  it('serializes intro eligibility so only one concurrent legacy trial enrollment is discounted', async () => {
    await giveUserCredits(user.id, 13_000_000);
    const [firstInstance, secondInstance] = await db
      .insert(kiloclaw_instances)
      .values([
        {
          user_id: user.id,
          sandbox_id: `ki_concurrent_intro_first_${user.id}`,
        },
        {
          user_id: user.id,
          sandbox_id: `ki_concurrent_intro_second_${user.id}`,
        },
      ])
      .returning();
    await db.insert(kiloclaw_subscriptions).values([
      {
        user_id: user.id,
        instance_id: firstInstance.id,
        plan: 'trial',
        status: 'trialing',
        kiloclaw_price_version: LEGACY_KILOCLAW_PRICE_VERSION,
      },
      {
        user_id: user.id,
        instance_id: secondInstance.id,
        plan: 'trial',
        status: 'trialing',
        kiloclaw_price_version: LEGACY_KILOCLAW_PRICE_VERSION,
      },
    ]);

    const { enrollWithCredits } = await import('@/lib/kiloclaw/credit-billing');
    await expect(
      Promise.all([
        enrollWithCredits({
          userId: user.id,
          instanceId: firstInstance.id,
          plan: 'standard',
          hadPaidSubscription: false,
        }),
        enrollWithCredits({
          userId: user.id,
          instanceId: secondInstance.id,
          plan: 'standard',
          hadPaidSubscription: false,
        }),
      ])
    ).resolves.toEqual([undefined, undefined]);

    const deductions = await db
      .select({ amountMicrodollars: credit_transactions.amount_microdollars })
      .from(credit_transactions)
      .where(eq(credit_transactions.kilo_user_id, user.id));
    expect(
      deductions
        .filter(row => row.amountMicrodollars < 0)
        .map(row => row.amountMicrodollars)
        .sort((a, b) => a - b)
    ).toEqual([-9_000_000, -4_000_000]);
  });

  it('serializes concurrent enrollment balance decisions for different instances', async () => {
    await giveUserCredits(user.id, 55_000_000);
    const [firstInstance, secondInstance] = await db
      .insert(kiloclaw_instances)
      .values([
        {
          user_id: user.id,
          sandbox_id: `ki_concurrent_first_${user.id}`,
        },
        {
          user_id: user.id,
          sandbox_id: `ki_concurrent_second_${user.id}`,
        },
      ])
      .returning();

    await db.insert(kiloclaw_subscriptions).values([
      {
        user_id: user.id,
        instance_id: firstInstance.id,
        plan: 'standard',
        status: 'canceled',
        payment_source: 'credits',
        kiloclaw_price_version: CURRENT_KILOCLAW_PRICE_VERSION,
      },
      {
        user_id: user.id,
        instance_id: secondInstance.id,
        plan: 'standard',
        status: 'canceled',
        payment_source: 'credits',
        kiloclaw_price_version: CURRENT_KILOCLAW_PRICE_VERSION,
      },
    ]);

    const { enrollWithCredits } = await import('@/lib/kiloclaw/credit-billing');
    const results = await Promise.allSettled([
      enrollWithCredits({
        userId: user.id,
        instanceId: firstInstance.id,
        plan: 'standard',
        hadPaidSubscription: true,
      }),
      enrollWithCredits({
        userId: user.id,
        instanceId: secondInstance.id,
        plan: 'standard',
        hadPaidSubscription: true,
      }),
    ]);

    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
    expect(results.find(result => result.status === 'rejected')).toEqual(
      expect.objectContaining({
        reason: expect.objectContaining({ reason: 'insufficient_credits' }),
      })
    );

    const [updatedUser] = await db
      .select({ microdollarsUsed: kilocode_users.microdollars_used })
      .from(kilocode_users)
      .where(eq(kilocode_users.id, user.id));
    expect(updatedUser.microdollarsUsed).toBe(55_000_000);

    const deductions = await db
      .select({ amountMicrodollars: credit_transactions.amount_microdollars })
      .from(credit_transactions)
      .where(eq(credit_transactions.kilo_user_id, user.id));
    expect(deductions.filter(row => row.amountMicrodollars < 0)).toHaveLength(1);

    const subscriptions = await db
      .select({ status: kiloclaw_subscriptions.status })
      .from(kiloclaw_subscriptions)
      .where(eq(kiloclaw_subscriptions.user_id, user.id));
    expect(subscriptions.filter(subscription => subscription.status === 'active')).toHaveLength(1);
    expect(subscriptions.filter(subscription => subscription.status === 'canceled')).toHaveLength(
      1
    );
  });

  it('deduction is idempotent via credit_category uniqueness', async () => {
    await createCreditEnrollmentAnchor(user.id);
    await giveUserCredits(user.id, 50_000_000);

    const caller = await createCallerForUser(user.id);
    await caller.kiloclaw.enrollWithCredits({ plan: 'standard' });

    // Second enrollment in the same period should fail
    // Reset subscription status so the enrollment guard doesn't reject first
    await db
      .update(kiloclaw_subscriptions)
      .set({ status: 'canceled' })
      .where(eq(kiloclaw_subscriptions.user_id, user.id));

    // Re-fetch user balance (it was decremented by first enrollment)
    await giveUserCredits(user.id, 100_000_000);

    await expect(caller.kiloclaw.enrollWithCredits({ plan: 'standard' })).rejects.toThrow(
      'Enrollment already processed for this billing period'
    );
  });
});

// ── Billing Status with Credits ────────────────────────────────────────────

describe('getBillingStatus with credits', () => {
  async function createKiloPassSubscription(params: {
    userId: string;
    status: Stripe.Subscription.Status;
    cancelAtPeriodEnd?: boolean;
    endedAt?: string | null;
    paymentProvider?: KiloPassPaymentProvider;
    providerSubscriptionId?: string | null;
  }) {
    const paymentProvider = params.paymentProvider ?? KiloPassPaymentProvider.Stripe;
    const stripeSubscriptionId =
      paymentProvider === KiloPassPaymentProvider.Stripe
        ? (params.providerSubscriptionId ?? `kp-stripe-sub-${crypto.randomUUID()}`)
        : null;
    const providerSubscriptionId =
      paymentProvider === KiloPassPaymentProvider.Stripe
        ? stripeSubscriptionId
        : (params.providerSubscriptionId ?? null);
    const [subscription] = await db
      .insert(kilo_pass_subscriptions)
      .values({
        kilo_user_id: params.userId,
        payment_provider: paymentProvider,
        provider_subscription_id: providerSubscriptionId,
        stripe_subscription_id: stripeSubscriptionId,
        tier: KiloPassTier.Tier19,
        cadence: KiloPassCadence.Monthly,
        status: params.status,
        cancel_at_period_end: params.cancelAtPeriodEnd ?? false,
        started_at: new Date().toISOString(),
        ended_at: params.endedAt ?? null,
        current_streak_months: 1,
        next_yearly_issue_at: null,
      })
      .returning({ id: kilo_pass_subscriptions.id });

    if (!subscription) {
      throw new Error('Failed to create Kilo Pass subscription');
    }

    return subscription;
  }

  it('includes hasStripeFunding=true for Stripe-funded subscription', async () => {
    await insertPersonalSubscriptionFixture({
      stripe_subscription_id: 'sub_stripe_funded',
      plan: 'standard',
      status: 'active',
    });

    const caller = await createCallerForUser(user.id);
    const result = await caller.kiloclaw.getBillingStatus();

    expect(result.subscription).not.toBeNull();
    expect(result.subscription!.hasStripeFunding).toBe(true);
  });

  it('includes hasStripeFunding=false for pure credit subscription', async () => {
    const [instance] = await db
      .insert(kiloclaw_instances)
      .values({ user_id: user.id, sandbox_id: `test-sandbox-${Math.random()}` })
      .returning();

    await db.insert(kiloclaw_subscriptions).values({
      user_id: user.id,
      instance_id: instance.id,
      payment_source: 'credits',
      plan: 'standard',
      status: 'active',
      current_period_start: new Date().toISOString(),
      current_period_end: new Date(Date.now() + 30 * 86_400_000).toISOString(),
      credit_renewal_at: new Date(Date.now() + 30 * 86_400_000).toISOString(),
      cancel_at_period_end: false,
    });

    const caller = await createCallerForUser(user.id);
    const result = await caller.kiloclaw.getBillingStatus();

    expect(result.subscription).not.toBeNull();
    expect(result.subscription!.hasStripeFunding).toBe(false);
  });

  it('includes credit balance in response', async () => {
    const caller = await createCallerForUser(user.id);
    const result = await caller.kiloclaw.getBillingStatus();

    expect(typeof result.creditBalanceMicrodollars).toBe('number');
  });

  it('reports pure credit subscription data (not suppressed)', async () => {
    const [instance] = await db
      .insert(kiloclaw_instances)
      .values({ user_id: user.id, sandbox_id: `test-sandbox-${Math.random()}` })
      .returning();

    await db.insert(kiloclaw_subscriptions).values({
      user_id: user.id,
      instance_id: instance.id,
      payment_source: 'credits',
      plan: 'standard',
      status: 'active',
      current_period_start: new Date().toISOString(),
      current_period_end: new Date(Date.now() + 30 * 86_400_000).toISOString(),
      credit_renewal_at: new Date(Date.now() + 30 * 86_400_000).toISOString(),
      cancel_at_period_end: false,
    });

    const caller = await createCallerForUser(user.id);
    const result = await caller.kiloclaw.getBillingStatus();

    expect(result.subscription).not.toBeNull();
    expect(result.subscription!.plan).toBe('standard');
    expect(result.subscription!.status).toBe('active');
    expect(result.subscription!.paymentSource).toBe('credits');
    expect(result.subscription!.creditRenewalAt).not.toBeNull();
    expect(result.subscription!.renewalCostMicrodollars).toBe(9_000_000);
  });

  it('reports live legacy subscription economics from the row price version', async () => {
    const [instance] = await db
      .insert(kiloclaw_instances)
      .values({ user_id: user.id, sandbox_id: `test-sandbox-${Math.random()}` })
      .returning();

    await db.insert(kiloclaw_subscriptions).values({
      user_id: user.id,
      instance_id: instance.id,
      payment_source: 'credits',
      plan: 'standard',
      status: 'active',
      current_period_start: '2026-04-01T00:00:00.000Z',
      current_period_end: '2026-05-01T00:00:00.000Z',
      credit_renewal_at: '2026-05-01T00:00:00.000Z',
      cancel_at_period_end: false,
      kiloclaw_price_version: LEGACY_KILOCLAW_PRICE_VERSION,
    });

    const caller = await createCallerForUser(user.id);
    const result = await caller.kiloclaw.getBillingStatus();

    expect(result.subscription).toMatchObject({
      priceVersion: LEGACY_KILOCLAW_PRICE_VERSION,
      selfServiceInstanceType: 'perf-1-3',
      renewalCostMicrodollars: 9_000_000,
    });
  });

  it('reports live current subscription economics from the row price version', async () => {
    const [instance] = await db
      .insert(kiloclaw_instances)
      .values({ user_id: user.id, sandbox_id: `test-sandbox-${Math.random()}` })
      .returning();

    await db.insert(kiloclaw_subscriptions).values({
      user_id: user.id,
      instance_id: instance.id,
      payment_source: 'credits',
      plan: 'commit',
      status: 'active',
      current_period_start: '2026-05-10T00:00:00.000Z',
      current_period_end: '2026-11-10T00:00:00.000Z',
      credit_renewal_at: '2026-11-10T00:00:00.000Z',
      cancel_at_period_end: false,
      kiloclaw_price_version: CURRENT_KILOCLAW_PRICE_VERSION,
    });

    const caller = await createCallerForUser(user.id);
    const result = await caller.kiloclaw.getBillingStatus();

    expect(result.subscription).toMatchObject({
      priceVersion: CURRENT_KILOCLAW_PRICE_VERSION,
      selfServiceInstanceType: 'perf-1-3',
      renewalCostMicrodollars: 306_000_000,
    });
  });

  it('reports fresh current signup economics after canceled legacy history', async () => {
    const [instance] = await db
      .insert(kiloclaw_instances)
      .values({
        user_id: user.id,
        sandbox_id: `test-sandbox-${Math.random()}`,
        destroyed_at: '2026-05-01T00:00:00.000Z',
      })
      .returning();

    await db.insert(kiloclaw_subscriptions).values({
      user_id: user.id,
      instance_id: instance.id,
      payment_source: 'credits',
      plan: 'standard',
      status: 'canceled',
      current_period_start: '2026-04-01T00:00:00.000Z',
      current_period_end: '2026-05-01T00:00:00.000Z',
      cancel_at_period_end: false,
      kiloclaw_price_version: LEGACY_KILOCLAW_PRICE_VERSION,
    });

    const caller = await createCallerForUser(user.id);
    const result = await caller.kiloclaw.getBillingStatus();

    expect(result).toMatchObject({
      creditIntroEligible: false,
      intendedPriceVersion: CURRENT_KILOCLAW_PRICE_VERSION,
      intendedSelfServiceInstanceType: 'perf-1-3',
      creditEnrollmentPreview: {
        standard: { costMicrodollars: 55_000_000 },
        commit: { costMicrodollars: 306_000_000 },
      },
    });
  });

  it('reports pure-credit renewal date, amount, and local renewal source', async () => {
    const [instance] = await db
      .insert(kiloclaw_instances)
      .values({ user_id: user.id, sandbox_id: `test-sandbox-${Math.random()}` })
      .returning();

    await db.insert(kiloclaw_subscriptions).values({
      user_id: user.id,
      instance_id: instance.id,
      payment_source: 'credits',
      plan: 'standard',
      status: 'active',
      current_period_start: '2026-05-10T00:00:00.000Z',
      current_period_end: '2026-06-10T00:00:00.000Z',
      credit_renewal_at: '2026-06-10T00:00:00.000Z',
      cancel_at_period_end: false,
      kiloclaw_price_version: CURRENT_KILOCLAW_PRICE_VERSION,
    });

    const caller = await createCallerForUser(user.id);
    const result = await caller.kiloclaw.getBillingStatus();

    expect(result.subscription).toMatchObject({
      hasStripeFunding: false,
      creditRenewalAt: '2026-06-10T00:00:00.000Z',
      renewalCostMicrodollars: 55_000_000,
      renewalCostSource: 'credit_renewal',
    });
  });

  it('uses Stripe funding indicator for hybrid conversion prompt, portal, and renewal source', async () => {
    stripeMock.billingPortal.sessions.create.mockResolvedValue({
      url: 'https://stripe.example.test/hybrid-portal',
    });
    await createKiloPassSubscription({ userId: user.id, status: 'active' });
    const [instance] = await db
      .insert(kiloclaw_instances)
      .values({ user_id: user.id, sandbox_id: `test-sandbox-${Math.random()}` })
      .returning();

    await db.insert(kiloclaw_subscriptions).values({
      user_id: user.id,
      instance_id: instance.id,
      stripe_subscription_id: 'sub_hybrid_status',
      payment_source: 'credits',
      plan: 'standard',
      status: 'active',
      current_period_start: '2026-05-10T00:00:00.000Z',
      current_period_end: '2026-06-10T00:00:00.000Z',
      credit_renewal_at: '2026-06-10T00:00:00.000Z',
      cancel_at_period_end: false,
      kiloclaw_price_version: CURRENT_KILOCLAW_PRICE_VERSION,
    });

    const caller = await createCallerForUser(user.id);
    const status = await caller.kiloclaw.getBillingStatus();
    const portal = await caller.kiloclaw.getCustomerPortalUrl({
      instanceId: instance.id,
    });

    expect(status.subscription).toMatchObject({
      paymentSource: 'credits',
      hasStripeFunding: true,
      showConversionPrompt: true,
      creditRenewalAt: '2026-06-10T00:00:00.000Z',
      renewalCostMicrodollars: 55_000_000,
      renewalCostSource: 'stripe_approximation',
    });
    expect(portal).toEqual({
      url: 'https://stripe.example.test/hybrid-portal',
    });
  });

  it('reports creditIntroEligible=true for new user with no subscription', async () => {
    const caller = await createCallerForUser(user.id);
    const result = await caller.kiloclaw.getBillingStatus();

    expect(result.creditIntroEligible).toBe(true);
  });

  it('reports creditIntroEligible=true for trialing user', async () => {
    const [instance] = await db
      .insert(kiloclaw_instances)
      .values({ user_id: user.id, sandbox_id: `test-sandbox-${Math.random()}` })
      .returning();

    await db.insert(kiloclaw_subscriptions).values({
      user_id: user.id,
      instance_id: instance.id,
      plan: 'trial',
      status: 'trialing',
      trial_started_at: new Date().toISOString(),
      trial_ends_at: new Date(Date.now() + 7 * 86_400_000).toISOString(),
    });

    const caller = await createCallerForUser(user.id);
    const result = await caller.kiloclaw.getBillingStatus();

    expect(result.creditIntroEligible).toBe(true);
  });

  it('reports creditIntroEligible=false for returning subscriber', async () => {
    const [instance] = await db
      .insert(kiloclaw_instances)
      .values({ user_id: user.id, sandbox_id: `test-sandbox-${Math.random()}` })
      .returning();

    await db.insert(kiloclaw_subscriptions).values({
      user_id: user.id,
      instance_id: instance.id,
      payment_source: 'credits',
      plan: 'standard',
      status: 'canceled',
      cancel_at_period_end: false,
    });

    const caller = await createCallerForUser(user.id);
    const result = await caller.kiloclaw.getBillingStatus();

    expect(result.creditIntroEligible).toBe(false);
  });

  it('reports hasActiveKiloPass=true for a non-ended Kilo Pass subscription', async () => {
    await createKiloPassSubscription({
      userId: user.id,
      status: 'active',
    });

    const caller = await createCallerForUser(user.id);
    const result = await caller.kiloclaw.getBillingStatus();

    expect(result.hasActiveKiloPass).toBe(true);
  });

  it('reports hasActiveKiloPass=false for an ended Kilo Pass subscription', async () => {
    await createKiloPassSubscription({
      userId: user.id,
      status: 'canceled',
      endedAt: new Date().toISOString(),
    });

    const caller = await createCallerForUser(user.id);
    const result = await caller.kiloclaw.getBillingStatus();

    expect(result.hasActiveKiloPass).toBe(false);
  });

  it('reports hasActiveKiloPass=false for an active App Store subscription whose latest purchase expired', async () => {
    const providerSubscriptionId = 'orig_kiloclaw_app_store_expired';
    const subscription = await createKiloPassSubscription({
      userId: user.id,
      status: 'active',
      paymentProvider: KiloPassPaymentProvider.AppStore,
      providerSubscriptionId,
    });

    await db.insert(kilo_pass_store_purchases).values({
      kilo_pass_subscription_id: subscription.id,
      kilo_user_id: user.id,
      payment_provider: KiloPassPaymentProvider.AppStore,
      product_id: 'kilo_pass_tier_19_monthly',
      provider_subscription_id: providerSubscriptionId,
      provider_transaction_id: 'tx_kiloclaw_app_store_expired',
      provider_original_transaction_id: providerSubscriptionId,
      app_account_token: user.app_store_account_token,
      environment: 'Sandbox',
      purchased_at: '2020-01-31T00:00:00.000Z',
      expires_at: '2020-02-28T00:00:00.000Z',
      raw_payload_json: {},
    });

    const caller = await createCallerForUser(user.id);
    const result = await caller.kiloclaw.getBillingStatus();

    expect(result.hasActiveKiloPass).toBe(false);
  });

  it('reports hasActiveKiloPass=true for an active App Store subscription whose latest purchase has not expired', async () => {
    const providerSubscriptionId = 'orig_kiloclaw_app_store_future_expiry';
    const subscription = await createKiloPassSubscription({
      userId: user.id,
      status: 'active',
      paymentProvider: KiloPassPaymentProvider.AppStore,
      providerSubscriptionId,
    });

    await db.insert(kilo_pass_store_purchases).values({
      kilo_pass_subscription_id: subscription.id,
      kilo_user_id: user.id,
      payment_provider: KiloPassPaymentProvider.AppStore,
      product_id: 'kilo_pass_tier_19_monthly',
      provider_subscription_id: providerSubscriptionId,
      provider_transaction_id: 'tx_kiloclaw_app_store_future_expiry',
      provider_original_transaction_id: providerSubscriptionId,
      app_account_token: user.app_store_account_token,
      environment: 'Sandbox',
      purchased_at: '2099-02-01T00:00:00.000Z',
      expires_at: '2099-03-01T00:00:00.000Z',
      raw_payload_json: {},
    });

    const caller = await createCallerForUser(user.id);
    const result = await caller.kiloclaw.getBillingStatus();

    expect(result.hasActiveKiloPass).toBe(true);
  });

  it('includes detached canonical history in the personal billing summary', async () => {
    await db.insert(kiloclaw_subscriptions).values({
      user_id: user.id,
      instance_id: null,
      plan: 'standard',
      status: 'active',
      payment_source: 'credits',
      kiloclaw_price_version: CURRENT_KILOCLAW_PRICE_VERSION,
    });

    const caller = await createCallerForUser(user.id);
    const result = await caller.kiloclaw.getPersonalBillingSummary();

    expect(result.hasExistingPersonalSubscription).toBe(true);
    expect(result.hasCurrentPersonalSubscription).toBe(true);
    expect(result.hasActiveInstance).toBe(false);
  });

  it('reports legacy recurring Standard upsell cost when prior paid history removes intro eligibility', async () => {
    const trialInstance = await createKiloclawInstance(user.id);
    const canceledPaidInstance = await createKiloclawInstance(user.id, '2026-04-01T00:00:00.000Z');
    await db.insert(kiloclaw_subscriptions).values([
      {
        user_id: user.id,
        instance_id: trialInstance.id,
        plan: 'trial',
        status: 'trialing',
        trial_started_at: new Date().toISOString(),
        trial_ends_at: new Date(Date.now() + 7 * 86_400_000).toISOString(),
        kiloclaw_price_version: LEGACY_KILOCLAW_PRICE_VERSION,
      },
      {
        user_id: user.id,
        instance_id: canceledPaidInstance.id,
        plan: 'standard',
        status: 'canceled',
        payment_source: 'credits',
        kiloclaw_price_version: LEGACY_KILOCLAW_PRICE_VERSION,
      },
    ]);

    const caller = await createCallerForUser(user.id);
    const result = await caller.kiloclaw.getPersonalBillingSummary();

    expect(result.kiloPassUpsellPreview.standard.monthly['19']).toEqual(
      expect.objectContaining({
        eligible: true,
        costMicrodollars: 9_000_000,
        projectedKiloPassBaseMicrodollars: 19_000_000,
        shortfallMicrodollars: 0,
      })
    );
    expect(result.kiloPassUpsellPreview.commit.monthly['49']).toEqual(
      expect.objectContaining({
        eligible: true,
        costMicrodollars: 48_000_000,
        shortfallMicrodollars: 0,
      })
    );
  });

  it('includes Kilo Pass upsell preview data for versioned first charges and shortfalls', async () => {
    await db
      .update(kilocode_users)
      .set({
        total_microdollars_acquired: 4_000_000,
        microdollars_used: 0,
        kilo_pass_threshold: null,
      })
      .where(eq(kilocode_users.id, user.id));

    const caller = await createCallerForUser(user.id);
    const result = await caller.kiloclaw.getPersonalBillingSummary();

    expect(result.kiloPassUpsellPreview.standard.monthly['49']).toEqual({
      eligible: true,
      costMicrodollars: 55_000_000,
      projectedKiloPassBaseMicrodollars: 49_000_000,
      projectedKiloPassBonusMicrodollars: 2_450_000,
      effectiveBalanceMicrodollars: 55_450_000,
      shortfallMicrodollars: 0,
    });
    expect(result.kiloPassUpsellPreview.commit.yearly['199']).toEqual({
      eligible: false,
      costMicrodollars: 306_000_000,
      projectedKiloPassBaseMicrodollars: 199_000_000,
      projectedKiloPassBonusMicrodollars: 99_500_000,
      effectiveBalanceMicrodollars: 302_500_000,
      shortfallMicrodollars: 3_500_000,
    });
  });

  it('includes plan-specific effective balance previews with projected Kilo Pass bonus', async () => {
    await db
      .update(kilocode_users)
      .set({
        total_microdollars_acquired: 0,
        microdollars_used: 0,
        kilo_pass_threshold: 4_000_000,
      })
      .where(eq(kilocode_users.id, user.id));

    const stripeSubscriptionId = `kp-stripe-sub-${crypto.randomUUID()}`;
    await db.insert(kilo_pass_subscriptions).values({
      kilo_user_id: user.id,
      provider_subscription_id: stripeSubscriptionId,
      stripe_subscription_id: stripeSubscriptionId,
      tier: KiloPassTier.Tier19,
      cadence: KiloPassCadence.Yearly,
      status: 'active',
      cancel_at_period_end: false,
      started_at: new Date().toISOString(),
      current_streak_months: 1,
      next_yearly_issue_at: null,
    });

    const caller = await createCallerForUser(user.id);
    const result = await caller.kiloclaw.getBillingStatus();

    expect(result.creditEnrollmentPreview.standard.costMicrodollars).toBe(55_000_000);
    expect(result.creditEnrollmentPreview.standard.projectedKiloPassBonusMicrodollars).toBe(
      9_500_000
    );
    expect(result.creditEnrollmentPreview.standard.effectiveBalanceMicrodollars).toBe(9_500_000);

    expect(result.creditEnrollmentPreview.commit.costMicrodollars).toBe(306_000_000);
    expect(result.creditEnrollmentPreview.commit.projectedKiloPassBonusMicrodollars).toBe(
      9_500_000
    );
    expect(result.creditEnrollmentPreview.commit.effectiveBalanceMicrodollars).toBe(9_500_000);
  });
});
