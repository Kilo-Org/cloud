import {
  createCallerForUser,
  createKiloclawInstance,
  insertPersonalSubscriptionFixture,
  stripeMock,
  user,
} from './kiloclaw-billing-router.test-harness';
import { describe, expect, it } from '@jest/globals';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { credit_transactions, kiloclaw_subscriptions } from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';

const CLOSED_MESSAGE =
  'KiloClaw hosting can no longer be started or renewed. Existing hosting runs until the end of its paid period.';

async function insertSubscription(
  values: Partial<typeof kiloclaw_subscriptions.$inferInsert> = {}
) {
  const instance = await createKiloclawInstance(user.id);
  await insertPersonalSubscriptionFixture({
    instanceId: instance.id,
    stripe_subscription_id: 'sub_closure',
    plan: 'standard',
    status: 'active',
    ...values,
  });
  return instance.id;
}

async function readSubscription() {
  const [subscription] = await db
    .select()
    .from(kiloclaw_subscriptions)
    .where(eq(kiloclaw_subscriptions.user_id, user.id));
  return subscription;
}

describe('KiloClaw hosting closure', () => {
  it('rejects every path that starts hosting for a canceled subscriber', async () => {
    const instanceId = await insertSubscription({ status: 'canceled' });
    const caller = await createCallerForUser(user.id);

    await expect(
      caller.kiloclaw.createSubscriptionCheckout({ plan: 'standard', instanceId })
    ).rejects.toThrow(CLOSED_MESSAGE);
    await expect(
      caller.kiloclaw.enrollWithCredits({ plan: 'standard', instanceId })
    ).rejects.toThrow(CLOSED_MESSAGE);
    await expect(
      caller.kiloclaw.createKiloPassUpsellCheckout({
        instanceId,
        tier: '19',
        cadence: 'monthly',
        hostingPlan: 'standard',
      })
    ).rejects.toThrow(CLOSED_MESSAGE);

    expect(stripeMock.checkout.sessions.create).not.toHaveBeenCalled();
    expect((await readSubscription())?.status).toBe('canceled');
    const transactions = await db
      .select()
      .from(credit_transactions)
      .where(eq(credit_transactions.kilo_user_id, user.id));
    expect(transactions).toHaveLength(0);
  });

  it('rejects reactivation and keeps the pending cancellation', async () => {
    const instanceId = await insertSubscription({ cancel_at_period_end: true });
    const caller = await createCallerForUser(user.id);

    await expect(caller.kiloclaw.reactivateSubscription()).rejects.toThrow(CLOSED_MESSAGE);
    await expect(caller.kiloclaw.reactivateSubscriptionAtInstance({ instanceId })).rejects.toThrow(
      CLOSED_MESSAGE
    );

    expect(stripeMock.subscriptions.update).not.toHaveBeenCalled();
    expect((await readSubscription())?.cancel_at_period_end).toBe(true);
  });

  it('rejects plan switches, Commit continuation, and credit conversion', async () => {
    const instanceId = await insertSubscription({ plan: 'commit' });
    const caller = await createCallerForUser(user.id);

    await expect(caller.kiloclaw.switchPlan({ toPlan: 'standard' })).rejects.toThrow(
      CLOSED_MESSAGE
    );
    await expect(
      caller.kiloclaw.switchPlanAtInstance({ instanceId, toPlan: 'standard' })
    ).rejects.toThrow(CLOSED_MESSAGE);
    await expect(caller.kiloclaw.continueCommitAsStandard({ instanceId })).rejects.toThrow(
      CLOSED_MESSAGE
    );
    await expect(caller.kiloclaw.acceptConversion()).rejects.toThrow(CLOSED_MESSAGE);
    await expect(caller.kiloclaw.acceptConversionAtInstance({ instanceId })).rejects.toThrow(
      CLOSED_MESSAGE
    );

    expect(stripeMock.subscriptions.update).not.toHaveBeenCalled();
    expect((await readSubscription())?.scheduled_plan).toBeNull();
  });

  it('still allows cancellation', async () => {
    await insertSubscription();
    stripeMock.subscriptions.retrieve.mockResolvedValue({ schedule: null });
    stripeMock.subscriptions.update.mockResolvedValue({});
    const caller = await createCallerForUser(user.id);

    await expect(caller.kiloclaw.cancelSubscription()).resolves.toEqual({ success: true });
    expect((await readSubscription())?.cancel_at_period_end).toBe(true);
  });
});
