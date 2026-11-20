import {
  createCallerForUser,
  createCanceledTrialAndPaidSubscriptions,
  createKiloclawInstance,
  insertPersonalSubscriptionFixture,
  stripeMock,
  user,
} from './kiloclaw-billing-router.test-harness';
import { describe, expect, it } from '@jest/globals';
import { db } from '@kilocode/web-shared/lib/drizzle';
import {
  kiloclaw_subscriptions,
  kiloclaw_instances,
  kiloclaw_subscription_change_log,
} from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';
import { createOrganization } from '@kilocode/web-shared/lib/organizations/organizations';

describe('cancelSubscription', () => {
  it('sets cancel_at_period_end for commit subscription without schedule', async () => {
    await insertPersonalSubscriptionFixture({
      stripe_subscription_id: 'sub_commit',
      plan: 'commit',
      status: 'active',
    });

    stripeMock.subscriptions.retrieve.mockResolvedValue({ schedule: null });
    stripeMock.subscriptions.update.mockResolvedValue({});

    const caller = await createCallerForUser(user.id);
    const result = await caller.kiloclaw.cancelSubscription();

    expect(result).toEqual({ success: true });
    expect(stripeMock.subscriptionSchedules.release).not.toHaveBeenCalled();
    expect(stripeMock.subscriptions.update).toHaveBeenCalledWith('sub_commit', {
      cancel_at_period_end: true,
    });

    const [row] = await db
      .select()
      .from(kiloclaw_subscriptions)
      .where(eq(kiloclaw_subscriptions.user_id, user.id))
      .limit(1);

    expect(row.cancel_at_period_end).toBe(true);

    const logs = await db
      .select()
      .from(kiloclaw_subscription_change_log)
      .where(eq(kiloclaw_subscription_change_log.subscription_id, row.id));
    expect(logs).toHaveLength(1);
    expect(logs[0]).toEqual(
      expect.objectContaining({
        actor_type: 'user',
        actor_id: user.id,
        action: 'canceled',
        reason: 'user_requested_cancellation',
      })
    );
    expect(logs[0]?.before_state).toEqual(
      expect.objectContaining({
        cancel_at_period_end: false,
      })
    );
    expect(logs[0]?.after_state).toEqual(
      expect.objectContaining({
        cancel_at_period_end: true,
      })
    );
  });

  it('cancels the effective paid subscription when a canceled trial also exists', async () => {
    const { paidSubscription, trialSubscription } = await createCanceledTrialAndPaidSubscriptions({
      paidStripeSubscriptionId: 'sub_effective_cancel',
    });

    stripeMock.subscriptions.retrieve.mockResolvedValue({ schedule: null });
    stripeMock.subscriptions.update.mockResolvedValue({});

    const caller = await createCallerForUser(user.id);
    const result = await caller.kiloclaw.cancelSubscription();

    expect(result).toEqual({ success: true });
    expect(stripeMock.subscriptions.update).toHaveBeenCalledWith('sub_effective_cancel', {
      cancel_at_period_end: true,
    });

    const rows = await db
      .select()
      .from(kiloclaw_subscriptions)
      .where(eq(kiloclaw_subscriptions.user_id, user.id));
    const updatedPaid = rows.find(row => row.id === paidSubscription.id);
    const unchangedTrial = rows.find(row => row.id === trialSubscription.id);

    expect(updatedPaid?.cancel_at_period_end).toBe(true);
    expect(unchangedTrial?.cancel_at_period_end).toBe(false);
  });

  it('releases user-initiated plan switch schedule on cancel', async () => {
    await insertPersonalSubscriptionFixture({
      stripe_subscription_id: 'sub_with_switch',
      plan: 'commit',
      status: 'active',
      stripe_schedule_id: 'sched_user',
      scheduled_plan: 'standard',
      scheduled_by: 'user',
    });

    stripeMock.subscriptions.retrieve.mockResolvedValue({ schedule: null });
    stripeMock.subscriptionSchedules.release.mockResolvedValue({});
    stripeMock.subscriptions.update.mockResolvedValue({});

    const caller = await createCallerForUser(user.id);
    const result = await caller.kiloclaw.cancelSubscription();

    expect(result).toEqual({ success: true });
    expect(stripeMock.subscriptionSchedules.release).toHaveBeenCalledWith('sched_user');

    const [row] = await db
      .select()
      .from(kiloclaw_subscriptions)
      .where(eq(kiloclaw_subscriptions.user_id, user.id))
      .limit(1);

    expect(row.cancel_at_period_end).toBe(true);
    expect(row.stripe_schedule_id).toBeNull();
    expect(row.scheduled_plan).toBeNull();
  });

  it('proceeds when schedule is already released', async () => {
    await insertPersonalSubscriptionFixture({
      stripe_subscription_id: 'sub_commit_2',
      plan: 'commit',
      status: 'active',
      stripe_schedule_id: 'sched_gone',
      scheduled_plan: 'standard',
      scheduled_by: 'user',
    });

    stripeMock.subscriptions.retrieve.mockResolvedValue({ schedule: null });
    stripeMock.subscriptionSchedules.release.mockRejectedValue(
      new Error('This schedule is not active and cannot be released')
    );
    stripeMock.subscriptions.update.mockResolvedValue({});

    const caller = await createCallerForUser(user.id);
    const result = await caller.kiloclaw.cancelSubscription();

    expect(result).toEqual({ success: true });
  });

  it('aborts cancellation when schedule release fails with transient error', async () => {
    await insertPersonalSubscriptionFixture({
      stripe_subscription_id: 'sub_commit_3',
      plan: 'commit',
      status: 'active',
      stripe_schedule_id: 'sched_fail',
      scheduled_plan: 'standard',
      scheduled_by: 'user',
    });

    stripeMock.subscriptions.retrieve.mockResolvedValue({ schedule: null });
    stripeMock.subscriptionSchedules.release.mockRejectedValue(new Error('Stripe API timeout'));

    const caller = await createCallerForUser(user.id);
    await expect(caller.kiloclaw.cancelSubscription()).rejects.toThrow(
      'Unable to cancel: failed to release pending plan schedule.'
    );

    // Local state must be unchanged — schedule still referenced
    const [row] = await db
      .select()
      .from(kiloclaw_subscriptions)
      .where(eq(kiloclaw_subscriptions.user_id, user.id))
      .limit(1);

    expect(row.stripe_schedule_id).toBe('sched_fail');
    expect(row.cancel_at_period_end).toBe(false);
  });

  it('detects and releases hidden schedule when DB has no pointer but Stripe has schedule', async () => {
    await insertPersonalSubscriptionFixture({
      stripe_subscription_id: 'sub_hidden_sched',
      plan: 'standard',
      status: 'active',
      // No stripe_schedule_id in DB
    });

    stripeMock.subscriptions.retrieve.mockResolvedValue({
      schedule: 'sched_hidden',
    });
    stripeMock.subscriptionSchedules.release.mockResolvedValue({});
    stripeMock.subscriptions.update.mockResolvedValue({});

    const caller = await createCallerForUser(user.id);
    const result = await caller.kiloclaw.cancelSubscription();

    expect(result).toEqual({ success: true });
    expect(stripeMock.subscriptionSchedules.release).toHaveBeenCalledWith('sched_hidden');
  });
});

describe('cancelPlanSwitch', () => {
  it('releases user schedule and clears DB fields', async () => {
    await insertPersonalSubscriptionFixture({
      stripe_subscription_id: 'sub_cancel_switch',
      plan: 'standard',
      status: 'active',
      stripe_schedule_id: 'sched_user_switch',
      scheduled_plan: 'commit',
      scheduled_by: 'user',
    });

    stripeMock.subscriptionSchedules.release.mockResolvedValue({});
    // ensureAutoIntroSchedule will check price — return regular price so it no-ops
    stripeMock.subscriptions.retrieve.mockResolvedValue({
      schedule: null,
      items: { data: [{ price: { id: 'price_standard' } }] },
    });

    const caller = await createCallerForUser(user.id);
    const result = await caller.kiloclaw.cancelPlanSwitch();

    expect(result).toEqual({ success: true });
    expect(stripeMock.subscriptionSchedules.release).toHaveBeenCalledWith('sched_user_switch');

    const [row] = await db
      .select()
      .from(kiloclaw_subscriptions)
      .where(eq(kiloclaw_subscriptions.user_id, user.id))
      .limit(1);
    expect(row.stripe_schedule_id).toBeNull();
    expect(row.scheduled_plan).toBeNull();
    expect(row.scheduled_by).toBeNull();

    const logs = await db
      .select()
      .from(kiloclaw_subscription_change_log)
      .where(eq(kiloclaw_subscription_change_log.subscription_id, row.id));
    expect(logs).toHaveLength(1);
    expect(logs[0]).toEqual(
      expect.objectContaining({
        actor_type: 'user',
        actor_id: user.id,
        action: 'schedule_changed',
        reason: 'user_canceled_plan_switch',
      })
    );
    expect(logs[0]?.before_state).toEqual(
      expect.objectContaining({
        scheduled_plan: 'commit',
        scheduled_by: 'user',
        stripe_schedule_id: 'sched_user_switch',
      })
    );
    expect(logs[0]?.after_state).toEqual(
      expect.objectContaining({
        scheduled_plan: null,
        scheduled_by: null,
        stripe_schedule_id: null,
      })
    );
  });

  it('cancels the effective paid plan switch when a canceled trial also exists', async () => {
    const { paidSubscription, trialSubscription } = await createCanceledTrialAndPaidSubscriptions({
      paidStripeSubscriptionId: 'sub_cancel_switch_effective',
      paidStripeScheduleId: 'sched_effective_user_switch',
      paidScheduledPlan: 'commit',
      paidScheduledBy: 'user',
    });

    stripeMock.subscriptionSchedules.release.mockResolvedValue({});
    stripeMock.subscriptions.retrieve.mockResolvedValue({
      schedule: null,
      items: { data: [{ price: { id: 'price_standard' } }] },
    });

    const caller = await createCallerForUser(user.id);
    const result = await caller.kiloclaw.cancelPlanSwitch();

    expect(result).toEqual({ success: true });
    expect(stripeMock.subscriptionSchedules.release).toHaveBeenCalledWith(
      'sched_effective_user_switch'
    );

    const rows = await db
      .select()
      .from(kiloclaw_subscriptions)
      .where(eq(kiloclaw_subscriptions.user_id, user.id));
    const updatedPaid = rows.find(row => row.id === paidSubscription.id);
    const unchangedTrial = rows.find(row => row.id === trialSubscription.id);

    expect(updatedPaid?.stripe_schedule_id).toBeNull();
    expect(updatedPaid?.scheduled_plan).toBeNull();
    expect(updatedPaid?.scheduled_by).toBeNull();
    expect(unchangedTrial?.scheduled_plan).toBeNull();
  });

  it('restores auto schedule when canceling switch during intro month', async () => {
    await insertPersonalSubscriptionFixture({
      stripe_subscription_id: 'sub_cancel_switch_intro',
      plan: 'standard',
      status: 'active',
      stripe_schedule_id: 'sched_user_intro',
      scheduled_plan: 'commit',
      scheduled_by: 'user',
    });

    stripeMock.subscriptionSchedules.release.mockResolvedValue({});
    // Return intro price so ensureAutoIntroSchedule creates a schedule
    stripeMock.subscriptions.retrieve.mockResolvedValue({
      schedule: null,
      items: { data: [{ price: { id: 'price_standard_intro' } }] },
    });
    stripeMock.subscriptionSchedules.create.mockResolvedValue({
      id: 'sched_auto_restored',
      phases: [
        {
          items: [{ price: 'price_standard_intro' }],
          start_date: 1000,
          end_date: 2000,
        },
      ],
    });
    stripeMock.subscriptionSchedules.update.mockResolvedValue({});

    const caller = await createCallerForUser(user.id);
    const result = await caller.kiloclaw.cancelPlanSwitch();

    expect(result).toEqual({ success: true });
    // Should have restored the auto schedule
    expect(stripeMock.subscriptionSchedules.create).toHaveBeenCalled();

    const [row] = await db
      .select()
      .from(kiloclaw_subscriptions)
      .where(eq(kiloclaw_subscriptions.user_id, user.id))
      .limit(1);
    // After ensureAutoIntroSchedule, DB should have the restored schedule
    expect(row.stripe_schedule_id).toBe('sched_auto_restored');
    expect(row.scheduled_plan).toBe('standard');
    expect(row.scheduled_by).toBe('auto');
  });

  it('rejects when no user-initiated schedule exists', async () => {
    await insertPersonalSubscriptionFixture({
      stripe_subscription_id: 'sub_no_switch',
      plan: 'standard',
      status: 'active',
      stripe_schedule_id: 'sched_auto_only',
      scheduled_plan: 'standard',
      scheduled_by: 'auto',
    });

    const caller = await createCallerForUser(user.id);
    await expect(caller.kiloclaw.cancelPlanSwitch()).rejects.toThrow(
      'No user-initiated plan switch to cancel'
    );
  });

  it('succeeds when schedule is already released', async () => {
    await insertPersonalSubscriptionFixture({
      stripe_subscription_id: 'sub_already_released',
      plan: 'standard',
      status: 'active',
      stripe_schedule_id: 'sched_gone',
      scheduled_plan: 'commit',
      scheduled_by: 'user',
    });

    stripeMock.subscriptionSchedules.release.mockRejectedValue(
      new Error('This schedule is not active and cannot be released')
    );
    stripeMock.subscriptions.retrieve.mockResolvedValue({
      schedule: null,
      items: { data: [{ price: { id: 'price_standard' } }] },
    });

    const caller = await createCallerForUser(user.id);
    const result = await caller.kiloclaw.cancelPlanSwitch();

    expect(result).toEqual({ success: true });
  });
});

// ── org-subscription coexistence ──────────────────────────────────────────

describe('personal billing mutations do not affect org subscriptions', () => {
  async function createPersonalAndOrgSubscriptions(overrides?: {
    personalCancelAtPeriodEnd?: boolean;
    personalScheduledPlan?: 'standard' | 'commit';
    personalScheduledBy?: 'user' | 'auto';
    personalStripeScheduleId?: string;
  }) {
    const organization = await createOrganization('Org Coexistence', user.id);
    const orgInstance = await db
      .insert(kiloclaw_instances)
      .values({
        user_id: user.id,
        organization_id: organization.id,
        sandbox_id: `test-sandbox-${crypto.randomUUID()}`,
      })
      .returning()
      .then(rows => rows[0]!);

    const personalInstance = await createKiloclawInstance(user.id);

    const [orgSub] = await db
      .insert(kiloclaw_subscriptions)
      .values({
        user_id: user.id,
        instance_id: orgInstance.id,
        stripe_subscription_id: 'sub_org_coexist',
        plan: 'standard',
        status: 'active',
        current_period_end: '2026-06-01T00:00:00.000Z',
      })
      .returning();

    const [personalSub] = await db
      .insert(kiloclaw_subscriptions)
      .values({
        user_id: user.id,
        instance_id: personalInstance.id,
        stripe_subscription_id: 'sub_personal_coexist',
        plan: 'standard',
        status: 'active',
        cancel_at_period_end: overrides?.personalCancelAtPeriodEnd ?? false,
        stripe_schedule_id: overrides?.personalStripeScheduleId,
        scheduled_plan: overrides?.personalScheduledPlan,
        scheduled_by: overrides?.personalScheduledBy,
        current_period_start: '2026-04-01T00:00:00.000Z',
        current_period_end: '2026-05-01T00:00:00.000Z',
      })
      .returning();

    return {
      orgInstance,
      personalInstance,
      orgSub: orgSub!,
      personalSub: personalSub!,
    };
  }

  it('cancelSubscription targets the personal subscription, not the org one', async () => {
    const { orgSub, personalSub } = await createPersonalAndOrgSubscriptions();

    stripeMock.subscriptions.retrieve.mockResolvedValue({ schedule: null });
    stripeMock.subscriptions.update.mockResolvedValue({});

    const caller = await createCallerForUser(user.id);
    const result = await caller.kiloclaw.cancelSubscription();

    expect(result).toEqual({ success: true });
    expect(stripeMock.subscriptions.update).toHaveBeenCalledWith('sub_personal_coexist', {
      cancel_at_period_end: true,
    });

    const rows = await db
      .select()
      .from(kiloclaw_subscriptions)
      .where(eq(kiloclaw_subscriptions.user_id, user.id));
    const updatedPersonal = rows.find(row => row.id === personalSub.id);
    const unchangedOrg = rows.find(row => row.id === orgSub.id);

    expect(updatedPersonal?.cancel_at_period_end).toBe(true);
    expect(unchangedOrg?.cancel_at_period_end).toBe(false);
  });

  it('cancelPlanSwitch targets the personal subscription, not the org one', async () => {
    const { orgSub, personalSub } = await createPersonalAndOrgSubscriptions({
      personalStripeScheduleId: 'sched_personal_switch',
      personalScheduledPlan: 'commit',
      personalScheduledBy: 'user',
    });

    stripeMock.subscriptionSchedules.release.mockResolvedValue({});
    stripeMock.subscriptions.retrieve.mockResolvedValue({
      schedule: null,
      items: { data: [{ price: { id: 'price_standard' } }] },
    });

    const caller = await createCallerForUser(user.id);
    const result = await caller.kiloclaw.cancelPlanSwitch();

    expect(result).toEqual({ success: true });
    expect(stripeMock.subscriptionSchedules.release).toHaveBeenCalledWith('sched_personal_switch');

    const rows = await db
      .select()
      .from(kiloclaw_subscriptions)
      .where(eq(kiloclaw_subscriptions.user_id, user.id));
    const updatedPersonal = rows.find(row => row.id === personalSub.id);
    const unchangedOrg = rows.find(row => row.id === orgSub.id);

    expect(updatedPersonal?.stripe_schedule_id).toBeNull();
    expect(updatedPersonal?.scheduled_plan).toBeNull();
    expect(unchangedOrg?.scheduled_plan).toBeNull();
  });
});

// ── cancelPlanSwitch ───────────────────────────────────────────────────────

describe('cancelPlanSwitch', () => {
  it('releases the schedule and clears DB fields on happy path', async () => {
    await insertPersonalSubscriptionFixture({
      stripe_subscription_id: 'sub_cancel_test',
      plan: 'commit',
      status: 'active',
      stripe_schedule_id: 'sub_sched_cancel',
      scheduled_plan: 'standard',
      scheduled_by: 'user',
    });

    stripeMock.subscriptionSchedules.release.mockResolvedValue({});

    const caller = await createCallerForUser(user.id);
    const result = await caller.kiloclaw.cancelPlanSwitch();

    expect(result).toEqual({ success: true });
    expect(stripeMock.subscriptionSchedules.release).toHaveBeenCalledWith('sub_sched_cancel');

    const [row] = await db
      .select()
      .from(kiloclaw_subscriptions)
      .where(eq(kiloclaw_subscriptions.user_id, user.id))
      .limit(1);

    expect(row.stripe_schedule_id).toBeNull();
    expect(row.scheduled_plan).toBeNull();
    expect(row.scheduled_by).toBeNull();
  });

  it('rejects when no pending plan switch exists', async () => {
    await insertPersonalSubscriptionFixture({
      stripe_subscription_id: 'sub_no_schedule',
      plan: 'commit',
      status: 'active',
    });

    const caller = await createCallerForUser(user.id);
    await expect(caller.kiloclaw.cancelPlanSwitch()).rejects.toThrow(
      'No pending plan switch to cancel'
    );
  });

  it('rejects when the pending switch was not user-initiated', async () => {
    await insertPersonalSubscriptionFixture({
      stripe_subscription_id: 'sub_system_switch',
      plan: 'commit',
      status: 'active',
      stripe_schedule_id: 'sub_sched_system',
      scheduled_plan: 'standard',
      scheduled_by: 'auto',
    });

    const caller = await createCallerForUser(user.id);
    await expect(caller.kiloclaw.cancelPlanSwitch()).rejects.toThrow(
      'No user-initiated plan switch to cancel'
    );
  });

  it('clears DB when Stripe says schedule is already released', async () => {
    await insertPersonalSubscriptionFixture({
      stripe_subscription_id: 'sub_already_released',
      plan: 'commit',
      status: 'active',
      stripe_schedule_id: 'sub_sched_gone',
      scheduled_plan: 'standard',
      scheduled_by: 'user',
    });

    const alreadyReleasedError = new stripeMock.errors.StripeInvalidRequestError({
      message: 'This schedule has already been released',
      type: 'invalid_request_error',
    });
    stripeMock.subscriptionSchedules.release.mockRejectedValue(alreadyReleasedError);

    const caller = await createCallerForUser(user.id);
    const result = await caller.kiloclaw.cancelPlanSwitch();

    expect(result).toEqual({ success: true });

    const [row] = await db
      .select()
      .from(kiloclaw_subscriptions)
      .where(eq(kiloclaw_subscriptions.user_id, user.id))
      .limit(1);

    expect(row.stripe_schedule_id).toBeNull();
    expect(row.scheduled_plan).toBeNull();
  });

  it('clears DB when Stripe says schedule is already canceled', async () => {
    await insertPersonalSubscriptionFixture({
      stripe_subscription_id: 'sub_already_canceled',
      plan: 'commit',
      status: 'active',
      stripe_schedule_id: 'sub_sched_canceled',
      scheduled_plan: 'standard',
      scheduled_by: 'user',
    });

    const alreadyCanceledError = new stripeMock.errors.StripeInvalidRequestError({
      message: 'This schedule has already been canceled',
      type: 'invalid_request_error',
    });
    stripeMock.subscriptionSchedules.release.mockRejectedValue(alreadyCanceledError);

    const caller = await createCallerForUser(user.id);
    const result = await caller.kiloclaw.cancelPlanSwitch();

    expect(result).toEqual({ success: true });

    const [row] = await db
      .select()
      .from(kiloclaw_subscriptions)
      .where(eq(kiloclaw_subscriptions.user_id, user.id))
      .limit(1);

    expect(row.stripe_schedule_id).toBeNull();
    expect(row.scheduled_plan).toBeNull();
  });

  it('rethrows non-already-released Stripe errors', async () => {
    await insertPersonalSubscriptionFixture({
      stripe_subscription_id: 'sub_stripe_fail',
      plan: 'commit',
      status: 'active',
      stripe_schedule_id: 'sub_sched_fail',
      scheduled_plan: 'standard',
      scheduled_by: 'user',
    });

    stripeMock.subscriptionSchedules.release.mockRejectedValue(new Error('Stripe network timeout'));

    const caller = await createCallerForUser(user.id);
    await expect(caller.kiloclaw.cancelPlanSwitch()).rejects.toThrow(
      'Failed to release pending plan schedule'
    );

    // DB should NOT have been cleared since Stripe failed
    const [row] = await db
      .select()
      .from(kiloclaw_subscriptions)
      .where(eq(kiloclaw_subscriptions.user_id, user.id))
      .limit(1);

    expect(row.stripe_schedule_id).toBe('sub_sched_fail');
  });
});

// ── Pure Credit Cancel/Reactivate/SwitchPlan/CancelPlanSwitch ──────────────

describe('pure credit cancel', () => {
  async function createPureCreditSubscription(
    userId: string,
    plan: 'standard' | 'commit' = 'standard',
    overrides: Record<string, unknown> = {}
  ) {
    const [instance] = await db
      .insert(kiloclaw_instances)
      .values({ user_id: userId, sandbox_id: `test-sandbox-${Math.random()}` })
      .returning();

    await db.insert(kiloclaw_subscriptions).values({
      user_id: userId,
      instance_id: instance.id,
      payment_source: 'credits',
      plan,
      status: 'active',
      current_period_start: new Date().toISOString(),
      current_period_end: new Date(Date.now() + 30 * 86_400_000).toISOString(),
      credit_renewal_at: new Date(Date.now() + 30 * 86_400_000).toISOString(),
      cancel_at_period_end: false,
      ...overrides,
    });

    return instance;
  }

  it('cancels pure credit subscription without Stripe API call', async () => {
    await createPureCreditSubscription(user.id);

    const caller = await createCallerForUser(user.id);
    const result = await caller.kiloclaw.cancelSubscription();

    expect(result).toEqual({ success: true });

    // No Stripe calls should have been made
    expect(stripeMock.subscriptions.update).not.toHaveBeenCalled();
    expect(stripeMock.subscriptions.retrieve).not.toHaveBeenCalled();
    expect(stripeMock.subscriptionSchedules.release).not.toHaveBeenCalled();

    const [row] = await db
      .select()
      .from(kiloclaw_subscriptions)
      .where(eq(kiloclaw_subscriptions.user_id, user.id))
      .limit(1);

    expect(row.cancel_at_period_end).toBe(true);
    // Schedule fields should be cleared defensively
    expect(row.stripe_schedule_id).toBeNull();
    expect(row.scheduled_plan).toBeNull();
    expect(row.scheduled_by).toBeNull();
  });

  it('cancels plan switch for pure credit subscription locally', async () => {
    await createPureCreditSubscription(user.id, 'standard', {
      scheduled_plan: 'commit',
      scheduled_by: 'user',
    });

    const caller = await createCallerForUser(user.id);
    const result = await caller.kiloclaw.cancelPlanSwitch();

    expect(result).toEqual({ success: true });

    // No Stripe calls
    expect(stripeMock.subscriptionSchedules.release).not.toHaveBeenCalled();

    const [row] = await db
      .select()
      .from(kiloclaw_subscriptions)
      .where(eq(kiloclaw_subscriptions.user_id, user.id))
      .limit(1);

    expect(row.scheduled_plan).toBeNull();
    expect(row.scheduled_by).toBeNull();

    const logs = await db
      .select()
      .from(kiloclaw_subscription_change_log)
      .where(eq(kiloclaw_subscription_change_log.subscription_id, row.id));
    expect(logs).toHaveLength(1);
    expect(logs[0]).toEqual(
      expect.objectContaining({
        actor_type: 'user',
        actor_id: user.id,
        action: 'schedule_changed',
        reason: 'user_canceled_plan_switch',
      })
    );
    expect(logs[0]?.before_state).toEqual(
      expect.objectContaining({
        scheduled_plan: 'commit',
        scheduled_by: 'user',
      })
    );
    expect(logs[0]?.after_state).toEqual(
      expect.objectContaining({
        scheduled_plan: null,
        scheduled_by: null,
      })
    );
  });
});
