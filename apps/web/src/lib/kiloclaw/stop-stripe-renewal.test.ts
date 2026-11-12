import { cleanupDbForTest, db } from '@kilocode/web-shared/lib/drizzle';
import { client as stripeClient } from '@kilocode/web-shared/lib/stripe-client';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import {
  kiloclaw_admin_audit_logs,
  kiloclaw_subscription_change_log,
  kiloclaw_subscriptions,
} from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';

import { LEGACY_KILOCLAW_PRICE_VERSION } from '@kilocode/db';
import {
  KiloClawStripeRenewalReconciliationConflictError,
  KiloClawStripeRenewalMissingLocalSubscriptionError,
  stopKiloClawStripeRenewal,
} from './stop-stripe-renewal';

const actor = { id: 'admin-stop-renewal', email: 'admin@example.com', name: 'Admin' };
const stripeRequestOptions = { timeout: expect.any(Number), maxNetworkRetries: 0 };

describe('stopKiloClawStripeRenewal', () => {
  beforeEach(async () => {
    await cleanupDbForTest();
    jest.restoreAllMocks();
  });

  async function createSubscription(
    overrides: Partial<typeof kiloclaw_subscriptions.$inferInsert> = {}
  ) {
    const user = await insertTestUser();
    const [subscription] = await db
      .insert(kiloclaw_subscriptions)
      .values({
        user_id: user.id,
        stripe_subscription_id: 'sub_stop_renewal',
        payment_source: 'stripe',
        kiloclaw_price_version: LEGACY_KILOCLAW_PRICE_VERSION,
        plan: 'standard',
        status: 'active',
        ...overrides,
      })
      .returning();
    if (!subscription) throw new Error('Expected test subscription');
    return subscription;
  }

  function mockStripe(subscription: Record<string, unknown>) {
    jest.spyOn(stripeClient.subscriptions, 'retrieve').mockResolvedValue(subscription as never);
    return jest.spyOn(stripeClient.subscriptions, 'update').mockResolvedValue({} as never);
  }

  it('releases an active attached schedule, stops renewal, and records both histories', async () => {
    const subscription = await createSubscription({
      stripe_schedule_id: 'sched_stop_renewal',
      scheduled_plan: 'commit',
      scheduled_by: 'user',
    });
    const update = mockStripe({
      id: 'sub_stop_renewal',
      status: 'active',
      schedule: 'sched_stop_renewal',
      cancel_at_period_end: false,
      cancel_at: null,
    });
    jest
      .spyOn(stripeClient.subscriptionSchedules, 'retrieve')
      .mockResolvedValue({ id: 'sched_stop_renewal', status: 'active' } as never);
    const release = jest
      .spyOn(stripeClient.subscriptionSchedules, 'release')
      .mockResolvedValue({ id: 'sched_stop_renewal', status: 'released' } as never);

    await expect(
      stopKiloClawStripeRenewal({
        stripeSubscriptionId: 'sub_stop_renewal',
        actor,
        runId: 'run-stop-renewal',
      })
    ).resolves.toEqual({ outcome: 'updated' });

    expect(release).toHaveBeenCalledWith(
      'sched_stop_renewal',
      {
        preserve_cancel_date: true,
      },
      stripeRequestOptions
    );
    expect(update).toHaveBeenCalledWith(
      'sub_stop_renewal',
      { cancel_at_period_end: true },
      stripeRequestOptions
    );
    const [updated] = await db
      .select()
      .from(kiloclaw_subscriptions)
      .where(eq(kiloclaw_subscriptions.id, subscription.id));
    expect(updated).toEqual(
      expect.objectContaining({
        cancel_at_period_end: true,
        stripe_schedule_id: null,
        scheduled_plan: null,
        scheduled_by: null,
      })
    );
    await expect(
      db
        .select()
        .from(kiloclaw_subscription_change_log)
        .where(eq(kiloclaw_subscription_change_log.subscription_id, subscription.id))
    ).resolves.toHaveLength(1);
    await expect(
      db
        .select()
        .from(kiloclaw_admin_audit_logs)
        .where(eq(kiloclaw_admin_audit_logs.target_user_id, subscription.user_id))
    ).resolves.toEqual([
      expect.objectContaining({
        metadata: expect.objectContaining({
          runId: 'run-stop-renewal',
          reason: 'KiloClaw end of life',
        }),
      }),
    ]);
  });

  it('does not call Stripe update for an already canceled subscription', async () => {
    const subscription = await createSubscription({
      payment_source: 'credits',
      cancel_at_period_end: true,
      stripe_schedule_id: 'sched_stale',
      scheduled_plan: 'commit',
      scheduled_by: 'user',
    });
    const update = mockStripe({
      id: 'sub_stop_renewal',
      status: 'canceled',
      schedule: null,
      cancel_at_period_end: false,
      cancel_at: null,
    });

    await expect(
      stopKiloClawStripeRenewal({
        stripeSubscriptionId: 'sub_stop_renewal',
        actor,
        runId: 'run-canceled',
      })
    ).resolves.toEqual({ outcome: 'already_canceled' });

    expect(update).not.toHaveBeenCalled();
    const [updated] = await db
      .select()
      .from(kiloclaw_subscriptions)
      .where(eq(kiloclaw_subscriptions.id, subscription.id));
    expect(updated).toEqual(
      expect.objectContaining({
        status: 'active',
        cancel_at_period_end: true,
        stripe_schedule_id: null,
        scheduled_plan: null,
        scheduled_by: null,
      })
    );
  });

  it('preserves an explicit Commit conversion while reconciling an existing cancellation', async () => {
    const subscription = await createSubscription({
      plan: 'commit',
      pending_conversion: true,
      cancel_at_period_end: true,
      stripe_schedule_id: 'sched_conversion',
      scheduled_plan: 'standard',
      scheduled_by: 'user',
    });
    const update = mockStripe({
      id: 'sub_stop_renewal',
      status: 'active',
      schedule: null,
      cancel_at_period_end: true,
      cancel_at: null,
    });

    await expect(
      stopKiloClawStripeRenewal({
        stripeSubscriptionId: 'sub_stop_renewal',
        actor,
        runId: 'run-conversion',
      })
    ).resolves.toEqual({ outcome: 'already_canceling' });

    expect(update).not.toHaveBeenCalled();
    const [updated] = await db
      .select()
      .from(kiloclaw_subscriptions)
      .where(eq(kiloclaw_subscriptions.id, subscription.id));
    expect(updated).toEqual(
      expect.objectContaining({
        pending_conversion: true,
        stripe_schedule_id: null,
        scheduled_plan: 'standard',
        scheduled_by: 'user',
      })
    );
  });

  it('preserves pending Commit conversion consent when the schedule webhook arrives first', async () => {
    const subscription = await createSubscription({
      plan: 'commit',
      pending_conversion: true,
      cancel_at_period_end: true,
      stripe_schedule_id: 'sched_conversion_interleaving',
      scheduled_plan: 'standard',
      scheduled_by: 'user',
    });
    const { handleKiloClawScheduleEvent } = await import('./stripe-handlers');
    jest
      .spyOn(stripeClient.subscriptions, 'retrieve')
      .mockResolvedValueOnce({
        id: 'sub_stop_renewal',
        status: 'active',
        schedule: 'sched_conversion_interleaving',
        cancel_at_period_end: true,
        cancel_at: null,
      } as never)
      .mockResolvedValueOnce({
        id: 'sub_stop_renewal',
        status: 'active',
        schedule: null,
        cancel_at_period_end: true,
        cancel_at: null,
      } as never);
    jest
      .spyOn(stripeClient.subscriptionSchedules, 'retrieve')
      .mockResolvedValue({ id: 'sched_conversion_interleaving', status: 'active' } as never);
    jest.spyOn(stripeClient.subscriptionSchedules, 'release').mockImplementation(async () => {
      await handleKiloClawScheduleEvent({
        eventId: 'evt_conversion_interleaving',
        schedule: {
          id: 'sched_conversion_interleaving',
          status: 'released',
          subscription: 'sub_stop_renewal',
        } as never,
      });
      return {} as never;
    });

    await expect(
      stopKiloClawStripeRenewal({
        stripeSubscriptionId: 'sub_stop_renewal',
        actor,
        runId: 'run-conversion-interleaving',
      })
    ).resolves.toEqual({ outcome: 'already_canceling' });

    const [updated] = await db
      .select()
      .from(kiloclaw_subscriptions)
      .where(eq(kiloclaw_subscriptions.id, subscription.id));
    expect(updated).toEqual(
      expect.objectContaining({
        pending_conversion: true,
        stripe_schedule_id: null,
        scheduled_plan: 'standard',
        scheduled_by: 'user',
      })
    );
  });

  it.each([
    { cancelAt: 1_600_000_000, label: 'before the current term boundary' },
    { cancelAt: 1_700_000_000, label: 'at the current term boundary' },
  ])('does not extend an explicit cancellation $label', async ({ cancelAt }) => {
    const subscription = await createSubscription({ cancel_at_period_end: true });
    const update = mockStripe({
      id: 'sub_stop_renewal',
      status: 'active',
      schedule: null,
      cancel_at_period_end: false,
      cancel_at: cancelAt,
      items: { data: [{ current_period_end: 1_700_000_000 }] },
    });

    await expect(
      stopKiloClawStripeRenewal({
        stripeSubscriptionId: 'sub_stop_renewal',
        actor,
        runId: `run-cancel-${cancelAt}`,
      })
    ).resolves.toEqual({ outcome: 'already_canceling' });

    expect(update).not.toHaveBeenCalled();
    const [updated] = await db
      .select()
      .from(kiloclaw_subscriptions)
      .where(eq(kiloclaw_subscriptions.id, subscription.id));
    expect(updated).toEqual(expect.objectContaining({ cancel_at_period_end: false }));
  });

  it('does not call Stripe when no local subscription matches', async () => {
    const retrieve = jest.spyOn(stripeClient.subscriptions, 'retrieve');
    const update = jest.spyOn(stripeClient.subscriptions, 'update');
    const scheduleRetrieve = jest.spyOn(stripeClient.subscriptionSchedules, 'retrieve');
    const scheduleRelease = jest.spyOn(stripeClient.subscriptionSchedules, 'release');

    await expect(
      stopKiloClawStripeRenewal({
        stripeSubscriptionId: 'sub_missing_local_row',
        actor,
        runId: 'run-missing-local-row',
      })
    ).rejects.toEqual(new KiloClawStripeRenewalMissingLocalSubscriptionError());

    expect(retrieve).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(scheduleRetrieve).not.toHaveBeenCalled();
    expect(scheduleRelease).not.toHaveBeenCalled();
  });

  it('caps a later explicit cancellation at the current term after schedule release', async () => {
    await createSubscription();
    const retrieve = jest.spyOn(stripeClient.subscriptions, 'retrieve');
    retrieve
      .mockResolvedValueOnce({
        id: 'sub_stop_renewal',
        status: 'active',
        schedule: 'sched_cancel_date',
        cancel_at_period_end: false,
        cancel_at: 1_800_000_000,
        items: { data: [{ current_period_end: 1_700_000_000 }] },
      } as never)
      .mockResolvedValueOnce({
        id: 'sub_stop_renewal',
        status: 'active',
        schedule: null,
        cancel_at_period_end: false,
        cancel_at: null,
        items: { data: [{ current_period_end: 1_700_000_000 }] },
      } as never);
    const update = jest.spyOn(stripeClient.subscriptions, 'update').mockResolvedValue({} as never);
    jest
      .spyOn(stripeClient.subscriptionSchedules, 'retrieve')
      .mockResolvedValue({ id: 'sched_cancel_date', status: 'active' } as never);
    jest.spyOn(stripeClient.subscriptionSchedules, 'release').mockResolvedValue({} as never);

    await expect(
      stopKiloClawStripeRenewal({
        stripeSubscriptionId: 'sub_stop_renewal',
        actor,
        runId: 'run-preserve-cancel-date',
      })
    ).resolves.toEqual({ outcome: 'already_canceling' });

    expect(update).toHaveBeenCalledWith(
      'sub_stop_renewal',
      { cancel_at: 1_700_000_000 },
      stripeRequestOptions
    );
  });

  it('releases a schedule Stripe reports even when the local row has no schedule pointer', async () => {
    await createSubscription();
    const update = mockStripe({
      id: 'sub_stop_renewal',
      status: 'active',
      schedule: 'sched_live_only',
      cancel_at_period_end: false,
      cancel_at: null,
    });
    jest
      .spyOn(stripeClient.subscriptionSchedules, 'retrieve')
      .mockResolvedValue({ id: 'sched_live_only', status: 'not_started' } as never);
    const release = jest
      .spyOn(stripeClient.subscriptionSchedules, 'release')
      .mockResolvedValue({} as never);

    await expect(
      stopKiloClawStripeRenewal({
        stripeSubscriptionId: 'sub_stop_renewal',
        actor,
        runId: 'run-live-only-schedule',
      })
    ).resolves.toEqual({ outcome: 'updated' });

    expect(release).toHaveBeenCalledWith(
      'sched_live_only',
      { preserve_cancel_date: true },
      stripeRequestOptions
    );
    expect(update).toHaveBeenCalledWith(
      'sub_stop_renewal',
      { cancel_at_period_end: true },
      stripeRequestOptions
    );
  });

  it('leaves the local row unchanged when schedule release fails', async () => {
    const subscription = await createSubscription({ stripe_schedule_id: 'sched_release_failure' });
    const update = mockStripe({
      id: 'sub_stop_renewal',
      status: 'active',
      schedule: 'sched_release_failure',
      cancel_at_period_end: false,
      cancel_at: null,
    });
    jest
      .spyOn(stripeClient.subscriptionSchedules, 'retrieve')
      .mockResolvedValue({ id: 'sched_release_failure', status: 'active' } as never);
    jest
      .spyOn(stripeClient.subscriptionSchedules, 'release')
      .mockRejectedValue(new Error('Stripe unavailable'));

    await expect(
      stopKiloClawStripeRenewal({
        stripeSubscriptionId: 'sub_stop_renewal',
        actor,
        runId: 'run-release-failure',
      })
    ).rejects.toThrow('Stripe unavailable');

    expect(update).not.toHaveBeenCalled();
    const [unchanged] = await db
      .select()
      .from(kiloclaw_subscriptions)
      .where(eq(kiloclaw_subscriptions.id, subscription.id));
    expect(unchanged).toEqual(expect.objectContaining({ cancel_at_period_end: false }));
  });

  it('fails visibly after a Stripe update when the local owner transfers', async () => {
    const subscription = await createSubscription();
    const [successor] = await db
      .insert(kiloclaw_subscriptions)
      .values({
        user_id: subscription.user_id,
        payment_source: 'credits',
        kiloclaw_price_version: LEGACY_KILOCLAW_PRICE_VERSION,
        plan: 'standard',
        status: 'active',
      })
      .returning();
    if (!successor) throw new Error('Expected successor subscription');
    jest.spyOn(stripeClient.subscriptions, 'retrieve').mockResolvedValue({
      id: 'sub_stop_renewal',
      status: 'active',
      schedule: null,
      cancel_at_period_end: false,
      cancel_at: null,
    } as never);
    jest.spyOn(stripeClient.subscriptions, 'update').mockImplementation(async () => {
      await db
        .update(kiloclaw_subscriptions)
        .set({ transferred_to_subscription_id: successor.id })
        .where(eq(kiloclaw_subscriptions.id, subscription.id));
      return {} as never;
    });

    await expect(
      stopKiloClawStripeRenewal({
        stripeSubscriptionId: 'sub_stop_renewal',
        actor,
        runId: 'run-local-conflict',
      })
    ).rejects.toBeInstanceOf(KiloClawStripeRenewalReconciliationConflictError);

    await expect(
      db
        .select()
        .from(kiloclaw_admin_audit_logs)
        .where(eq(kiloclaw_admin_audit_logs.target_user_id, subscription.user_id))
    ).resolves.toHaveLength(1);
  });

  it('uses live Stripe renewal state without changing a differing local status', async () => {
    const subscription = await createSubscription({ status: 'canceled' });
    const update = mockStripe({
      id: 'sub_stop_renewal',
      status: 'active',
      schedule: null,
      cancel_at_period_end: false,
      cancel_at: null,
    });

    await expect(
      stopKiloClawStripeRenewal({
        stripeSubscriptionId: 'sub_stop_renewal',
        actor,
        runId: 'run-live-status-wins',
      })
    ).resolves.toEqual({ outcome: 'updated' });

    expect(update).toHaveBeenCalledWith(
      'sub_stop_renewal',
      { cancel_at_period_end: true },
      stripeRequestOptions
    );
    const [updated] = await db
      .select()
      .from(kiloclaw_subscriptions)
      .where(eq(kiloclaw_subscriptions.id, subscription.id));
    expect(updated).toEqual(
      expect.objectContaining({ status: 'canceled', cancel_at_period_end: true })
    );
  });

  it('does not change the local row when Stripe rejects the renewal update', async () => {
    const subscription = await createSubscription();
    jest.spyOn(stripeClient.subscriptions, 'retrieve').mockResolvedValue({
      id: 'sub_stop_renewal',
      status: 'active',
      schedule: null,
      cancel_at_period_end: false,
      cancel_at: null,
    } as never);
    jest
      .spyOn(stripeClient.subscriptions, 'update')
      .mockRejectedValue(new Error('Stripe update failed'));

    await expect(
      stopKiloClawStripeRenewal({
        stripeSubscriptionId: 'sub_stop_renewal',
        actor,
        runId: 'run-update-failure',
      })
    ).rejects.toThrow('Stripe update failed');

    const [unchanged] = await db
      .select()
      .from(kiloclaw_subscriptions)
      .where(eq(kiloclaw_subscriptions.id, subscription.id));
    expect(unchanged).toEqual(
      expect.objectContaining({ status: 'active', cancel_at_period_end: false })
    );
  });

  it('does not call Stripe after the renewal-stop deadline has elapsed', async () => {
    await createSubscription();
    const retrieve = jest.spyOn(stripeClient.subscriptions, 'retrieve');

    await expect(
      stopKiloClawStripeRenewal({
        stripeSubscriptionId: 'sub_stop_renewal',
        actor,
        runId: 'run-expired-deadline',
        deadlineAtMs: Date.now() - 1,
      })
    ).rejects.toThrow('Stripe renewal stop deadline exceeded.');

    expect(retrieve).not.toHaveBeenCalled();
  });
});
