import {
  PRE_COMMIT_CUTOFF_TIME,
  createCallerForUser,
  createCanceledTrialAndPaidSubscriptions,
  createKiloclawInstance,
  insertPersonalSubscriptionFixture,
  setTestSystemTime,
  stripeMock,
  stripePriceIdsMock,
  user,
} from './kiloclaw-billing-router.test-harness';
import { describe, expect, it, beforeEach } from '@jest/globals';
import { db } from '@kilocode/web-shared/lib/drizzle';
import {
  kiloclaw_subscriptions,
  kiloclaw_instances,
  kiloclaw_subscription_change_log,
} from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';
import { createOrganization } from '@kilocode/web-shared/lib/organizations/organizations';
import { LEGACY_KILOCLAW_PRICE_VERSION } from '@kilocode/db';

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

describe('reactivateSubscription', () => {
  it('blocks reactivation of an ambiguous legacy Commit subscription', async () => {
    const futureCommitEnd = new Date(Date.now() + 90 * 86_400_000).toISOString();
    await insertPersonalSubscriptionFixture({
      stripe_subscription_id: 'sub_reactivate',
      plan: 'commit',
      status: 'active',
      cancel_at_period_end: true,
      commit_ends_at: futureCommitEnd,
    });

    const caller = await createCallerForUser(user.id);
    await expect(caller.kiloclaw.reactivateSubscription()).rejects.toThrow(
      'Commit retirement state requires support review.'
    );
    expect(stripeMock.subscriptions.update).not.toHaveBeenCalled();

    const [row] = await db
      .select()
      .from(kiloclaw_subscriptions)
      .where(eq(kiloclaw_subscriptions.user_id, user.id))
      .limit(1);
    expect(row.cancel_at_period_end).toBe(true);
  });

  it('restores auto intro schedule after reactivating a standard intro-price subscription', async () => {
    await insertPersonalSubscriptionFixture({
      stripe_subscription_id: 'sub_reactivate_intro',
      plan: 'standard',
      status: 'active',
      cancel_at_period_end: true,
    });

    stripeMock.subscriptions.update.mockResolvedValue({});
    // ensureAutoIntroSchedule will call stripe.subscriptions.retrieve
    // Return intro price to trigger schedule creation
    stripeMock.subscriptions.retrieve.mockResolvedValue({
      schedule: null,
      items: { data: [{ price: { id: 'price_standard_intro' } }] },
    });
    stripeMock.subscriptionSchedules.create.mockResolvedValue({
      id: 'sub_sched_restored',
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
    const result = await caller.kiloclaw.reactivateSubscription();

    expect(result).toEqual({ success: true });
    // Schedule should have been created
    expect(stripeMock.subscriptionSchedules.create).toHaveBeenCalled();
  });

  it('reactivates the effective paid subscription when a canceled trial also exists', async () => {
    const { paidSubscription, trialSubscription } = await createCanceledTrialAndPaidSubscriptions({
      paidStripeSubscriptionId: 'sub_reactivate_effective',
      paidCancelAtPeriodEnd: true,
    });

    stripeMock.subscriptions.update.mockResolvedValue({});
    stripeMock.subscriptions.retrieve.mockResolvedValue({
      schedule: null,
      items: { data: [{ price: { id: 'price_standard' } }] },
    });

    const caller = await createCallerForUser(user.id);
    const result = await caller.kiloclaw.reactivateSubscription();

    expect(result).toEqual({ success: true });
    expect(stripeMock.subscriptions.update).toHaveBeenCalledWith('sub_reactivate_effective', {
      cancel_at_period_end: false,
    });

    const rows = await db
      .select()
      .from(kiloclaw_subscriptions)
      .where(eq(kiloclaw_subscriptions.user_id, user.id));
    const updatedPaid = rows.find(row => row.id === paidSubscription.id);
    const unchangedTrial = rows.find(row => row.id === trialSubscription.id);

    expect(updatedPaid?.cancel_at_period_end).toBe(false);
    expect(unchangedTrial?.cancel_at_period_end).toBe(false);
  });

  it('succeeds even if ensureAutoIntroSchedule throws after reactivation', async () => {
    await insertPersonalSubscriptionFixture({
      stripe_subscription_id: 'sub_reactivate_fail',
      plan: 'standard',
      status: 'active',
      cancel_at_period_end: true,
    });

    stripeMock.subscriptions.update.mockResolvedValue({});
    // Make ensureAutoIntroSchedule fail
    stripeMock.subscriptions.retrieve.mockRejectedValue(new Error('Stripe timeout'));

    const caller = await createCallerForUser(user.id);
    const result = await caller.kiloclaw.reactivateSubscription();

    // Should still succeed — reactivation is the primary operation
    expect(result).toEqual({ success: true });
    const [row] = await db
      .select()
      .from(kiloclaw_subscriptions)
      .where(eq(kiloclaw_subscriptions.user_id, user.id))
      .limit(1);
    expect(row.cancel_at_period_end).toBe(false);
  });

  it('rejects when the user has no subscriptions', async () => {
    const caller = await createCallerForUser(user.id);

    await expect(caller.kiloclaw.reactivateSubscription()).rejects.toThrow(
      'No pending cancellation to reactivate.'
    );
  });
});

describe('switchPlan', () => {
  beforeEach(() => {
    setTestSystemTime(PRE_COMMIT_CUTOFF_TIME);
  });

  it('creates a fresh schedule when switching standard to commit with no existing schedule', async () => {
    await insertPersonalSubscriptionFixture({
      stripe_subscription_id: 'sub_switch',
      plan: 'standard',
      status: 'active',
    });

    stripeMock.subscriptions.retrieve.mockResolvedValue({
      schedule: null,
      items: { data: [{ price: { id: 'price_standard' } }] },
    });
    stripeMock.subscriptionSchedules.create.mockResolvedValue({
      id: 'sub_sched_new',
      phases: [
        {
          items: [{ price: 'price_standard' }],
          start_date: 1000,
          end_date: 2000,
        },
      ],
    });
    stripeMock.subscriptionSchedules.update.mockResolvedValue({});

    const caller = await createCallerForUser(user.id);
    const result = await caller.kiloclaw.switchPlan({ toPlan: 'commit' });

    expect(result).toEqual({ success: true });
    expect(stripeMock.subscriptionSchedules.create).toHaveBeenCalled();
    expect(stripeMock.subscriptionSchedules.update).toHaveBeenCalled();

    const [dbRow] = await db
      .select()
      .from(kiloclaw_subscriptions)
      .where(eq(kiloclaw_subscriptions.user_id, user.id))
      .limit(1);
    expect(dbRow.stripe_schedule_id).toBe('sub_sched_new');
    expect(dbRow.scheduled_plan).toBe('commit');
    expect(dbRow.scheduled_by).toBe('user');

    const logs = await db
      .select()
      .from(kiloclaw_subscription_change_log)
      .where(eq(kiloclaw_subscription_change_log.subscription_id, dbRow.id));
    expect(logs).toHaveLength(1);
    expect(logs[0]).toEqual(
      expect.objectContaining({
        actor_type: 'user',
        actor_id: user.id,
        action: 'schedule_changed',
        reason: 'user_requested_plan_switch',
      })
    );
    expect(logs[0]?.before_state).toEqual(
      expect.objectContaining({
        scheduled_plan: null,
        scheduled_by: null,
        stripe_schedule_id: null,
      })
    );
    expect(logs[0]?.after_state).toEqual(
      expect.objectContaining({
        scheduled_plan: 'commit',
        scheduled_by: 'user',
        stripe_schedule_id: 'sub_sched_new',
      })
    );
  });

  it('uses the subscription price version for Stripe plan-switch target price', async () => {
    stripePriceIdsMock.getStripePriceIdForClawPlan.mockImplementation(
      (plan: string, options?: { priceVersion?: string }) =>
        `${options?.priceVersion ?? 'missing-version'}_${plan}`
    );

    await insertPersonalSubscriptionFixture({
      stripe_subscription_id: 'sub_switch_legacy_family',
      plan: 'standard',
      status: 'active',
      kiloclaw_price_version: LEGACY_KILOCLAW_PRICE_VERSION,
    });

    stripeMock.subscriptions.retrieve.mockResolvedValue({
      schedule: null,
      items: { data: [{ price: { id: 'price_legacy_standard' } }] },
    });
    stripeMock.subscriptionSchedules.create.mockResolvedValue({
      id: 'sub_sched_legacy_family',
      phases: [
        {
          items: [{ price: 'price_legacy_standard' }],
          start_date: 1000,
          end_date: 2000,
        },
      ],
    });
    stripeMock.subscriptionSchedules.update.mockResolvedValue({});

    const caller = await createCallerForUser(user.id);
    await caller.kiloclaw.switchPlan({ toPlan: 'commit' });

    expect(stripeMock.subscriptionSchedules.update).toHaveBeenCalledWith(
      'sub_sched_legacy_family',
      expect.objectContaining({
        phases: [
          expect.objectContaining({
            items: [{ price: 'price_legacy_standard' }],
          }),
          { items: [{ price: `${LEGACY_KILOCLAW_PRICE_VERSION}_commit` }] },
        ],
      })
    );
  });

  it('switches the effective paid subscription when a canceled trial also exists', async () => {
    const { paidSubscription, trialSubscription } = await createCanceledTrialAndPaidSubscriptions({
      paidStripeSubscriptionId: 'sub_switch_effective',
      paidPlan: 'standard',
    });

    stripeMock.subscriptions.retrieve.mockResolvedValue({
      schedule: null,
      items: { data: [{ price: { id: 'price_standard' } }] },
    });
    stripeMock.subscriptionSchedules.create.mockResolvedValue({
      id: 'sub_sched_effective',
      phases: [
        {
          items: [{ price: 'price_standard' }],
          start_date: 1000,
          end_date: 2000,
        },
      ],
    });
    stripeMock.subscriptionSchedules.update.mockResolvedValue({});

    const caller = await createCallerForUser(user.id);
    const result = await caller.kiloclaw.switchPlan({ toPlan: 'commit' });

    expect(result).toEqual({ success: true });
    expect(stripeMock.subscriptionSchedules.create).toHaveBeenCalledWith({
      from_subscription: 'sub_switch_effective',
    });

    const rows = await db
      .select()
      .from(kiloclaw_subscriptions)
      .where(eq(kiloclaw_subscriptions.user_id, user.id));
    const updatedPaid = rows.find(row => row.id === paidSubscription.id);
    const unchangedTrial = rows.find(row => row.id === trialSubscription.id);

    expect(updatedPaid?.stripe_schedule_id).toBe('sub_sched_effective');
    expect(updatedPaid?.scheduled_plan).toBe('commit');
    expect(updatedPaid?.scheduled_by).toBe('user');
    expect(unchangedTrial?.scheduled_plan).toBeNull();
  });

  it('rejects switch when user-initiated schedule already exists', async () => {
    await insertPersonalSubscriptionFixture({
      stripe_subscription_id: 'sub_switch_reject',
      plan: 'standard',
      status: 'active',
      stripe_schedule_id: 'sched_user_pending',
      scheduled_plan: 'commit',
      scheduled_by: 'user',
    });

    stripeMock.subscriptions.retrieve.mockResolvedValue({
      schedule: 'sched_user_pending',
      items: { data: [{ price: { id: 'price_standard' } }] },
    });

    const caller = await createCallerForUser(user.id);
    await expect(caller.kiloclaw.switchPlan({ toPlan: 'commit' })).rejects.toThrow(
      'A plan switch is already pending'
    );
  });

  it('updates auto schedule in place when switching standard (intro) to commit', async () => {
    await insertPersonalSubscriptionFixture({
      stripe_subscription_id: 'sub_switch_auto',
      plan: 'standard',
      status: 'active',
      stripe_schedule_id: 'sched_auto',
      scheduled_plan: 'standard',
      scheduled_by: 'auto',
    });

    stripeMock.subscriptions.retrieve.mockResolvedValue({
      schedule: 'sched_auto',
      items: { data: [{ price: { id: 'price_standard_intro' } }] },
    });
    stripeMock.subscriptionSchedules.retrieve.mockResolvedValue({
      id: 'sched_auto',
      metadata: { origin: 'auto-intro' },
      phases: [
        {
          items: [{ price: 'price_standard_intro' }],
          start_date: 1000,
          end_date: 2000,
        },
      ],
      status: 'active',
    });
    stripeMock.subscriptionSchedules.update.mockResolvedValue({});

    const caller = await createCallerForUser(user.id);
    const result = await caller.kiloclaw.switchPlan({ toPlan: 'commit' });

    expect(result).toEqual({ success: true });
    // Should update existing schedule, not create a new one
    expect(stripeMock.subscriptionSchedules.create).not.toHaveBeenCalled();
    expect(stripeMock.subscriptionSchedules.update).toHaveBeenCalledWith(
      'sched_auto',
      expect.objectContaining({
        end_behavior: 'release',
      })
    );

    const [row] = await db
      .select()
      .from(kiloclaw_subscriptions)
      .where(eq(kiloclaw_subscriptions.user_id, user.id))
      .limit(1);
    expect(row.stripe_schedule_id).toBe('sched_auto');
    expect(row.scheduled_plan).toBe('commit');
    expect(row.scheduled_by).toBe('user');
  });

  it('detects hidden auto schedule via live fetch and updates it in place', async () => {
    await insertPersonalSubscriptionFixture({
      stripe_subscription_id: 'sub_hidden_auto',
      plan: 'standard',
      status: 'active',
      // No stripe_schedule_id in DB
    });

    stripeMock.subscriptions.retrieve.mockResolvedValue({
      schedule: 'sched_hidden_auto',
      items: { data: [{ price: { id: 'price_standard_intro' } }] },
    });
    stripeMock.subscriptionSchedules.retrieve.mockResolvedValue({
      id: 'sched_hidden_auto',
      metadata: { origin: 'auto-intro' },
      phases: [
        {
          items: [{ price: 'price_standard_intro' }],
          start_date: 1000,
          end_date: 2000,
        },
      ],
      status: 'active',
    });
    stripeMock.subscriptionSchedules.update.mockResolvedValue({});

    const caller = await createCallerForUser(user.id);
    const result = await caller.kiloclaw.switchPlan({ toPlan: 'commit' });

    expect(result).toEqual({ success: true });
    expect(stripeMock.subscriptionSchedules.create).not.toHaveBeenCalled();

    const [row] = await db
      .select()
      .from(kiloclaw_subscriptions)
      .where(eq(kiloclaw_subscriptions.user_id, user.id))
      .limit(1);
    expect(row.scheduled_by).toBe('user');
    expect(row.scheduled_plan).toBe('commit');
  });

  it('releases hidden non-auto schedule and creates fresh schedule', async () => {
    await insertPersonalSubscriptionFixture({
      stripe_subscription_id: 'sub_hidden_user',
      plan: 'standard',
      status: 'active',
    });

    stripeMock.subscriptions.retrieve.mockResolvedValue({
      schedule: 'sched_hidden_user',
      items: { data: [{ price: { id: 'price_standard' } }] },
    });
    stripeMock.subscriptionSchedules.retrieve.mockResolvedValue({
      id: 'sched_hidden_user',
      metadata: {},
      phases: [
        {
          items: [{ price: 'price_standard' }],
          start_date: 1000,
          end_date: 2000,
        },
      ],
      status: 'active',
    });
    stripeMock.subscriptionSchedules.release.mockResolvedValue({});
    stripeMock.subscriptionSchedules.create.mockResolvedValue({
      id: 'sched_fresh',
      phases: [
        {
          items: [{ price: 'price_standard' }],
          start_date: 1000,
          end_date: 2000,
        },
      ],
    });
    stripeMock.subscriptionSchedules.update.mockResolvedValue({});

    const caller = await createCallerForUser(user.id);
    const result = await caller.kiloclaw.switchPlan({ toPlan: 'commit' });

    expect(result).toEqual({ success: true });
    expect(stripeMock.subscriptionSchedules.release).toHaveBeenCalledWith('sched_hidden_user');
    expect(stripeMock.subscriptionSchedules.create).toHaveBeenCalled();
  });

  it('rejects switch to same plan', async () => {
    await insertPersonalSubscriptionFixture({
      stripe_subscription_id: 'sub_same',
      plan: 'standard',
      status: 'active',
    });

    const caller = await createCallerForUser(user.id);
    await expect(caller.kiloclaw.switchPlan({ toPlan: 'standard' })).rejects.toThrow(
      'Already on this plan'
    );
  });

  it('aborts when releasing hidden non-auto schedule fails with transient error', async () => {
    await insertPersonalSubscriptionFixture({
      stripe_subscription_id: 'sub_hidden_fail',
      plan: 'standard',
      status: 'active',
    });

    stripeMock.subscriptions.retrieve.mockResolvedValue({
      schedule: 'sched_hidden_transient',
      items: { data: [{ price: { id: 'price_standard' } }] },
    });
    stripeMock.subscriptionSchedules.retrieve.mockResolvedValue({
      id: 'sched_hidden_transient',
      metadata: {},
      phases: [
        {
          items: [{ price: 'price_standard' }],
          start_date: 1000,
          end_date: 2000,
        },
      ],
      status: 'active',
    });
    // Transient error — not "not active" or "released" or "canceled"
    stripeMock.subscriptionSchedules.release.mockRejectedValue(new Error('Stripe API timeout'));

    const caller = await createCallerForUser(user.id);
    await expect(caller.kiloclaw.switchPlan({ toPlan: 'commit' })).rejects.toThrow(
      'Unable to switch plan: failed to release existing schedule'
    );
  });

  it('derives phase-1 price from the newly created schedule, not the stale live fetch', async () => {
    await insertPersonalSubscriptionFixture({
      stripe_subscription_id: 'sub_fresh_price',
      plan: 'standard',
      status: 'active',
    });

    // Live fetch returns the old intro price (stale by the time the schedule is created)
    stripeMock.subscriptions.retrieve.mockResolvedValue({
      schedule: null,
      items: { data: [{ price: { id: 'price_standard_intro' } }] },
    });
    // But from_subscription mirrors the subscription's current state at create time,
    // which has already rolled over to the regular price
    stripeMock.subscriptionSchedules.create.mockResolvedValue({
      id: 'sched_fresh_price',
      phases: [
        {
          items: [{ price: 'price_standard' }],
          start_date: 1000,
          end_date: 2000,
        },
      ],
    });
    stripeMock.subscriptionSchedules.update.mockResolvedValue({});

    const caller = await createCallerForUser(user.id);
    const result = await caller.kiloclaw.switchPlan({ toPlan: 'commit' });

    expect(result).toEqual({ success: true });
    // Phase 1 should use the fresh price from the schedule ('price_standard'),
    // not the stale intro price from the earlier subscriptions.retrieve()
    const updateArgs = stripeMock.subscriptionSchedules.update.mock.calls[0]?.[1] as Record<
      string,
      unknown
    >;
    const phases = updateArgs.phases as Array<{
      items: Array<{ price: string }>;
    }>;
    expect(phases[0].items[0].price).toBe('price_standard');
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

  it('reactivateSubscription targets the personal subscription, not the org one', async () => {
    const { orgSub, personalSub } = await createPersonalAndOrgSubscriptions({
      personalCancelAtPeriodEnd: true,
    });

    stripeMock.subscriptions.update.mockResolvedValue({});
    stripeMock.subscriptions.retrieve.mockResolvedValue({
      schedule: null,
      items: { data: [{ price: { id: 'price_standard' } }] },
    });

    const caller = await createCallerForUser(user.id);
    const result = await caller.kiloclaw.reactivateSubscription();

    expect(result).toEqual({ success: true });
    expect(stripeMock.subscriptions.update).toHaveBeenCalledWith('sub_personal_coexist', {
      cancel_at_period_end: false,
    });

    const rows = await db
      .select()
      .from(kiloclaw_subscriptions)
      .where(eq(kiloclaw_subscriptions.user_id, user.id));
    const updatedPersonal = rows.find(row => row.id === personalSub.id);
    const unchangedOrg = rows.find(row => row.id === orgSub.id);

    expect(updatedPersonal?.cancel_at_period_end).toBe(false);
    expect(unchangedOrg?.cancel_at_period_end).toBe(false);
  });

  it('switchPlan targets the personal subscription, not the org one', async () => {
    setTestSystemTime(PRE_COMMIT_CUTOFF_TIME);
    const { orgSub, personalSub } = await createPersonalAndOrgSubscriptions();

    stripeMock.subscriptions.retrieve.mockResolvedValue({
      schedule: null,
      items: { data: [{ price: { id: 'price_standard' } }] },
    });
    stripeMock.subscriptionSchedules.create.mockResolvedValue({
      id: 'sub_sched_personal',
      phases: [
        {
          items: [{ price: 'price_standard' }],
          start_date: 1000,
          end_date: 2000,
        },
      ],
    });
    stripeMock.subscriptionSchedules.update.mockResolvedValue({});

    const caller = await createCallerForUser(user.id);
    const result = await caller.kiloclaw.switchPlan({ toPlan: 'commit' });

    expect(result).toEqual({ success: true });
    expect(stripeMock.subscriptionSchedules.create).toHaveBeenCalledWith({
      from_subscription: 'sub_personal_coexist',
    });

    const rows = await db
      .select()
      .from(kiloclaw_subscriptions)
      .where(eq(kiloclaw_subscriptions.user_id, user.id));
    const updatedPersonal = rows.find(row => row.id === personalSub.id);
    const unchangedOrg = rows.find(row => row.id === orgSub.id);

    expect(updatedPersonal?.scheduled_plan).toBe('commit');
    expect(unchangedOrg?.scheduled_plan).toBeNull();
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

// ── switchPlan ─────────────────────────────────────────────────────────────

describe('switchPlan', () => {
  const now = Math.floor(Date.now() / 1000);

  function setupActiveSubscription(plan: 'commit' | 'standard') {
    return insertPersonalSubscriptionFixture({
      stripe_subscription_id: 'sub_switch_test',
      plan,
      status: 'active',
    });
  }

  function mockStripeForSwitchPlan(scheduleOnSub: string | null = null) {
    stripeMock.subscriptions.retrieve.mockResolvedValue({
      id: 'sub_switch_test',
      schedule: scheduleOnSub,
    });
    stripeMock.subscriptionSchedules.create.mockResolvedValue({
      id: 'sub_sched_new',
      phases: [
        {
          start_date: now,
          end_date: now + 86400 * 30,
          items: [{ price: 'price_test_kiloclaw' }],
        },
      ],
    });
    stripeMock.subscriptionSchedules.update.mockResolvedValue({
      id: 'sub_sched_new',
      status: 'active',
    });
    stripeMock.subscriptionSchedules.release.mockResolvedValue({});
  }

  it('creates a schedule and writes it to the DB on happy path', async () => {
    await setupActiveSubscription('commit');
    mockStripeForSwitchPlan();

    const caller = await createCallerForUser(user.id);
    const result = await caller.kiloclaw.switchPlan({ toPlan: 'standard' });

    expect(result).toEqual({ success: true });
    expect(stripeMock.subscriptionSchedules.create).toHaveBeenCalledWith({
      from_subscription: 'sub_switch_test',
    });
    expect(stripeMock.subscriptionSchedules.update).toHaveBeenCalledWith(
      'sub_sched_new',
      expect.objectContaining({ end_behavior: 'release' })
    );

    const [row] = await db
      .select()
      .from(kiloclaw_subscriptions)
      .where(eq(kiloclaw_subscriptions.user_id, user.id))
      .limit(1);

    expect(row.stripe_schedule_id).toBe('sub_sched_new');
    expect(row.scheduled_plan).toBe('standard');
    expect(row.scheduled_by).toBe('user');
  });

  it('rejects when user is already on the target plan', async () => {
    await setupActiveSubscription('standard');
    const caller = await createCallerForUser(user.id);

    await expect(caller.kiloclaw.switchPlan({ toPlan: 'standard' })).rejects.toThrow(
      'Already on this plan'
    );
  });

  it('rejects when subscription is not active', async () => {
    setTestSystemTime(PRE_COMMIT_CUTOFF_TIME);
    await insertPersonalSubscriptionFixture({
      stripe_subscription_id: 'sub_canceled',
      plan: 'standard',
      status: 'canceled',
    });

    const caller = await createCallerForUser(user.id);
    await expect(caller.kiloclaw.switchPlan({ toPlan: 'commit' })).rejects.toThrow(
      'No active subscription to switch'
    );
  });

  it('rejects when a pending plan switch already exists in the DB', async () => {
    await insertPersonalSubscriptionFixture({
      stripe_subscription_id: 'sub_switch_test',
      plan: 'commit',
      status: 'active',
      stripe_schedule_id: 'sub_sched_existing',
      scheduled_plan: 'standard',
      scheduled_by: 'user',
    });

    const caller = await createCallerForUser(user.id);
    await expect(caller.kiloclaw.switchPlan({ toPlan: 'standard' })).rejects.toThrow(
      'A plan switch is already pending'
    );

    // Should NOT have created or released anything on Stripe
    expect(stripeMock.subscriptionSchedules.create).not.toHaveBeenCalled();
  });

  it('releases an orphaned Stripe schedule not tracked in the DB', async () => {
    await setupActiveSubscription('commit');
    // DB has no stripe_schedule_id, but Stripe has an orphaned schedule attached
    mockStripeForSwitchPlan('sub_sched_orphaned');

    const caller = await createCallerForUser(user.id);
    await caller.kiloclaw.switchPlan({ toPlan: 'standard' });

    // Should have released the orphaned schedule first, then created a new one
    expect(stripeMock.subscriptionSchedules.release).toHaveBeenCalledWith('sub_sched_orphaned');
    expect(stripeMock.subscriptionSchedules.create).toHaveBeenCalledWith({
      from_subscription: 'sub_switch_test',
    });
  });

  it('aborts when orphaned schedule release fails with a transient error', async () => {
    await setupActiveSubscription('commit');

    stripeMock.subscriptions.retrieve.mockResolvedValue({
      id: 'sub_switch_test',
      schedule: 'sub_sched_orphaned',
    });
    stripeMock.subscriptionSchedules.release.mockRejectedValue(new Error('Stripe network timeout'));

    const caller = await createCallerForUser(user.id);
    await expect(caller.kiloclaw.switchPlan({ toPlan: 'standard' })).rejects.toThrow(
      'Unable to switch plan: failed to release existing schedule'
    );

    // Should NOT have attempted to create a new schedule
    expect(stripeMock.subscriptionSchedules.create).not.toHaveBeenCalled();
  });

  it('proceeds when orphaned schedule release says already released', async () => {
    await setupActiveSubscription('commit');

    const alreadyReleasedError = new stripeMock.errors.StripeInvalidRequestError({
      message: 'This schedule has already been released',
      type: 'invalid_request_error',
    });

    stripeMock.subscriptions.retrieve.mockResolvedValue({
      id: 'sub_switch_test',
      schedule: 'sub_sched_orphaned',
    });
    stripeMock.subscriptionSchedules.release.mockRejectedValueOnce(alreadyReleasedError);
    // Subsequent release calls (cleanup) succeed
    stripeMock.subscriptionSchedules.release.mockResolvedValue({});
    stripeMock.subscriptionSchedules.create.mockResolvedValue({
      id: 'sub_sched_new',
      phases: [
        {
          start_date: now,
          end_date: now + 86400 * 30,
          items: [{ price: 'price_test_kiloclaw' }],
        },
      ],
    });
    stripeMock.subscriptionSchedules.update.mockResolvedValue({
      id: 'sub_sched_new',
      status: 'active',
    });

    const caller = await createCallerForUser(user.id);
    const result = await caller.kiloclaw.switchPlan({ toPlan: 'standard' });

    expect(result).toEqual({ success: true });
    expect(stripeMock.subscriptionSchedules.create).toHaveBeenCalled();
  });

  it('cleans up orphaned schedule when stripe schedule update fails', async () => {
    await setupActiveSubscription('commit');

    stripeMock.subscriptions.retrieve.mockResolvedValue({
      id: 'sub_switch_test',
      schedule: null,
    });
    stripeMock.subscriptionSchedules.create.mockResolvedValue({
      id: 'sub_sched_orphan',
      phases: [
        {
          start_date: now,
          end_date: now + 86400 * 30,
          items: [{ price: 'price_test_kiloclaw' }],
        },
      ],
    });
    stripeMock.subscriptionSchedules.update.mockRejectedValue(new Error('Stripe update failed'));
    stripeMock.subscriptionSchedules.release.mockResolvedValue({});

    const caller = await createCallerForUser(user.id);
    await expect(caller.kiloclaw.switchPlan({ toPlan: 'standard' })).rejects.toThrow(
      'Stripe update failed'
    );

    // Best-effort cleanup should have released the orphaned schedule
    expect(stripeMock.subscriptionSchedules.release).toHaveBeenCalledWith('sub_sched_orphan');

    // DB should NOT have been updated with the orphaned schedule
    const [row] = await db
      .select()
      .from(kiloclaw_subscriptions)
      .where(eq(kiloclaw_subscriptions.user_id, user.id))
      .limit(1);

    expect(row.stripe_schedule_id).toBeNull();
  });

  it('uses optimistic concurrency to prevent double-write race', async () => {
    await setupActiveSubscription('commit');

    stripeMock.subscriptions.retrieve.mockResolvedValue({
      id: 'sub_switch_test',
      schedule: null,
    });
    stripeMock.subscriptionSchedules.create.mockResolvedValue({
      id: 'sub_sched_race',
      phases: [
        {
          start_date: now,
          end_date: now + 86400 * 30,
          items: [{ price: 'price_test_kiloclaw' }],
        },
      ],
    });
    // Simulate a concurrent request writing a schedule to the DB while our
    // Stripe schedule update is in-flight — after the DB guard passed but
    // before our optimistic DB write.
    stripeMock.subscriptionSchedules.update.mockImplementation(async () => {
      await db
        .update(kiloclaw_subscriptions)
        .set({
          stripe_schedule_id: 'sub_sched_concurrent',
          scheduled_plan: 'standard',
          scheduled_by: 'user',
        })
        .where(eq(kiloclaw_subscriptions.user_id, user.id));
      return { id: 'sub_sched_race', status: 'active' };
    });
    stripeMock.subscriptionSchedules.release.mockResolvedValue({});

    const caller = await createCallerForUser(user.id);
    await expect(caller.kiloclaw.switchPlan({ toPlan: 'standard' })).rejects.toThrow(
      'A plan switch is already pending'
    );

    // Should have released the schedule it created since the DB write lost the race
    expect(stripeMock.subscriptionSchedules.release).toHaveBeenCalledWith('sub_sched_race');

    // DB should still have the concurrent request's schedule
    const [row] = await db
      .select()
      .from(kiloclaw_subscriptions)
      .where(eq(kiloclaw_subscriptions.user_id, user.id))
      .limit(1);

    expect(row.stripe_schedule_id).toBe('sub_sched_concurrent');
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

describe('pure credit cancel/reactivate', () => {
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

  it('reactivates pure credit subscription without Stripe API call', async () => {
    await createPureCreditSubscription(user.id, 'standard', {
      cancel_at_period_end: true,
    });

    const caller = await createCallerForUser(user.id);
    const result = await caller.kiloclaw.reactivateSubscription();

    expect(result).toEqual({ success: true });

    // No Stripe calls
    expect(stripeMock.subscriptions.update).not.toHaveBeenCalled();

    const [row] = await db
      .select()
      .from(kiloclaw_subscriptions)
      .where(eq(kiloclaw_subscriptions.user_id, user.id))
      .limit(1);

    expect(row.cancel_at_period_end).toBe(false);
  });

  it('switches plan for pure credit subscription locally', async () => {
    setTestSystemTime(PRE_COMMIT_CUTOFF_TIME);
    await createPureCreditSubscription(user.id, 'standard');

    const caller = await createCallerForUser(user.id);
    const result = await caller.kiloclaw.switchPlan({ toPlan: 'commit' });

    expect(result).toEqual({ success: true });

    // No Stripe calls
    expect(stripeMock.subscriptionSchedules.create).not.toHaveBeenCalled();
    expect(stripeMock.subscriptionSchedules.update).not.toHaveBeenCalled();
    expect(stripeMock.subscriptions.retrieve).not.toHaveBeenCalled();

    const [row] = await db
      .select()
      .from(kiloclaw_subscriptions)
      .where(eq(kiloclaw_subscriptions.user_id, user.id))
      .limit(1);

    expect(row.scheduled_plan).toBe('commit');
    expect(row.scheduled_by).toBe('user');

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
        reason: 'user_requested_plan_switch',
      })
    );
    expect(logs[0]?.before_state).toEqual(
      expect.objectContaining({
        scheduled_plan: null,
        scheduled_by: null,
      })
    );
    expect(logs[0]?.after_state).toEqual(
      expect.objectContaining({
        scheduled_plan: 'commit',
        scheduled_by: 'user',
      })
    );
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
