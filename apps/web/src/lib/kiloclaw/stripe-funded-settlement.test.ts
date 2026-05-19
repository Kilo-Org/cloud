import { beforeEach, describe, expect, it } from '@jest/globals';
import { eq } from 'drizzle-orm';

import { CURRENT_KILOCLAW_PRICE_VERSION, LEGACY_KILOCLAW_PRICE_VERSION } from '@kilocode/db';
import {
  credit_transactions,
  kiloclaw_instances,
  kiloclaw_subscriptions,
  kilocode_users,
} from '@kilocode/db/schema';
import { cleanupDbForTest, db } from '@/lib/drizzle';
import { applyStripeFundedKiloClawPeriod } from '@/lib/kiloclaw/credit-billing';
import { insertTestUser } from '@/tests/helpers/user.helper';

async function insertPersonalInstance(params: { id: string; userId: string }) {
  await db.insert(kiloclaw_instances).values({
    id: params.id,
    user_id: params.userId,
    sandbox_id: `ki_${params.id.replaceAll('-', '')}`,
  });
}

async function readSubscription(id: string) {
  const [subscription] = await db
    .select()
    .from(kiloclaw_subscriptions)
    .where(eq(kiloclaw_subscriptions.id, id))
    .limit(1);
  return subscription;
}

async function readUser(id: string) {
  const [user] = await db.select().from(kilocode_users).where(eq(kilocode_users.id, id)).limit(1);
  return user;
}

describe('Stripe-funded KiloClaw settlement', () => {
  beforeEach(async () => {
    await cleanupDbForTest();
  });

  it('fails closed without mutating a current-price row when the invoice carries a legacy price version', async () => {
    const user = await insertTestUser({ id: 'settlement-version-mismatch-user' });
    const instanceId = '11111111-1111-4111-8111-111111111111';
    const subscriptionId = '22222222-2222-4222-8222-222222222222';
    const periodStart = '2026-05-01T00:00:00.000Z';
    const periodEnd = '2026-06-01T00:00:00.000Z';

    await insertPersonalInstance({ id: instanceId, userId: user.id });
    await db.insert(kiloclaw_subscriptions).values({
      id: subscriptionId,
      user_id: user.id,
      instance_id: instanceId,
      stripe_subscription_id: 'sub_price_version_mismatch',
      payment_source: 'stripe',
      kiloclaw_price_version: CURRENT_KILOCLAW_PRICE_VERSION,
      plan: 'standard',
      status: 'active',
      current_period_start: '2026-04-01T00:00:00.000Z',
      current_period_end: '2026-05-01T00:00:00.000Z',
    });

    const applied = await applyStripeFundedKiloClawPeriod({
      userId: user.id,
      metadataInstanceId: instanceId,
      stripeSubscriptionId: 'sub_price_version_mismatch',
      stripePaymentId: 'in_price_version_mismatch',
      plan: 'standard',
      priceVersion: LEGACY_KILOCLAW_PRICE_VERSION,
      amountMicrodollars: 4_000_000,
      periodStart,
      periodEnd,
    });

    expect(applied).toBe(false);

    await expect(readSubscription(subscriptionId)).resolves.toMatchObject({
      payment_source: 'stripe',
      kiloclaw_price_version: CURRENT_KILOCLAW_PRICE_VERSION,
      current_period_start: '2026-04-01 00:00:00+00',
      current_period_end: '2026-05-01 00:00:00+00',
    });

    await expect(readUser(user.id)).resolves.toMatchObject({
      total_microdollars_acquired: 0,
    });
    await expect(
      db.select().from(credit_transactions).where(eq(credit_transactions.kilo_user_id, user.id))
    ).resolves.toHaveLength(0);
  });

  it('activates a Stripe-funded subscription from a zero-dollar invoice', async () => {
    const user = await insertTestUser({ id: 'settlement-zero-dollar-user' });
    const instanceId = '55555555-5555-4555-8555-555555555555';
    const subscriptionId = '66666666-6666-4666-8666-666666666666';

    await insertPersonalInstance({ id: instanceId, userId: user.id });
    await db.insert(kiloclaw_subscriptions).values({
      id: subscriptionId,
      user_id: user.id,
      instance_id: instanceId,
      stripe_subscription_id: 'sub_zero_dollar',
      payment_source: 'stripe',
      kiloclaw_price_version: CURRENT_KILOCLAW_PRICE_VERSION,
      plan: 'trial',
      status: 'trialing',
      trial_started_at: '2026-05-01T00:00:00.000Z',
      trial_ends_at: '2026-05-02T00:00:00.000Z',
    });

    const applied = await applyStripeFundedKiloClawPeriod({
      userId: user.id,
      metadataInstanceId: instanceId,
      stripeSubscriptionId: 'sub_zero_dollar',
      stripePaymentId: 'in_zero_dollar',
      plan: 'standard',
      priceVersion: CURRENT_KILOCLAW_PRICE_VERSION,
      amountMicrodollars: 0,
      periodStart: '2026-05-02T00:00:00.000Z',
      periodEnd: '2026-06-02T00:00:00.000Z',
    });

    expect(applied).toBe(true);
    await expect(readSubscription(subscriptionId)).resolves.toMatchObject({
      payment_source: 'credits',
      status: 'active',
      plan: 'standard',
      current_period_start: '2026-05-02 00:00:00+00',
      current_period_end: '2026-06-02 00:00:00+00',
      credit_renewal_at: '2026-06-02 00:00:00+00',
    });
    await expect(readUser(user.id)).resolves.toMatchObject({
      total_microdollars_acquired: 0,
    });
  });

  it('routes settlement from a transferred predecessor to the current successor row', async () => {
    const user = await insertTestUser({ id: 'settlement-transferred-user' });
    const oldInstanceId = '77777777-7777-4777-8777-777777777777';
    const newInstanceId = '88888888-8888-4888-8888-888888888888';
    const predecessorId = '99999999-9999-4999-8999-999999999999';
    const successorId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

    await insertPersonalInstance({ id: oldInstanceId, userId: user.id });
    await insertPersonalInstance({ id: newInstanceId, userId: user.id });
    await db.insert(kiloclaw_subscriptions).values({
      id: successorId,
      user_id: user.id,
      instance_id: newInstanceId,
      payment_source: 'credits',
      kiloclaw_price_version: LEGACY_KILOCLAW_PRICE_VERSION,
      plan: 'standard',
      status: 'active',
      current_period_start: '2026-04-01T00:00:00.000Z',
      current_period_end: '2026-05-01T00:00:00.000Z',
      credit_renewal_at: '2026-05-01T00:00:00.000Z',
    });
    await db.insert(kiloclaw_subscriptions).values({
      id: predecessorId,
      user_id: user.id,
      instance_id: oldInstanceId,
      stripe_subscription_id: 'sub_transferred_predecessor',
      payment_source: 'stripe',
      kiloclaw_price_version: LEGACY_KILOCLAW_PRICE_VERSION,
      plan: 'standard',
      status: 'active',
      current_period_start: '2026-03-01T00:00:00.000Z',
      current_period_end: '2026-04-01T00:00:00.000Z',
      transferred_to_subscription_id: successorId,
    });

    const applied = await applyStripeFundedKiloClawPeriod({
      userId: user.id,
      metadataInstanceId: oldInstanceId,
      stripeSubscriptionId: 'sub_transferred_predecessor',
      stripePaymentId: 'in_transferred_predecessor',
      plan: 'standard',
      priceVersion: LEGACY_KILOCLAW_PRICE_VERSION,
      amountMicrodollars: 9_000_000,
      periodStart: '2026-05-01T00:00:00.000Z',
      periodEnd: '2026-06-01T00:00:00.000Z',
    });

    expect(applied).toBe(true);
    await expect(readSubscription(predecessorId)).resolves.toMatchObject({
      stripe_subscription_id: null,
      payment_source: 'credits',
      transferred_to_subscription_id: successorId,
      current_period_end: '2026-04-01 00:00:00+00',
    });
    await expect(readSubscription(successorId)).resolves.toMatchObject({
      instance_id: newInstanceId,
      stripe_subscription_id: 'sub_transferred_predecessor',
      payment_source: 'credits',
      kiloclaw_price_version: LEGACY_KILOCLAW_PRICE_VERSION,
      current_period_start: '2026-05-01 00:00:00+00',
      current_period_end: '2026-06-01 00:00:00+00',
      credit_renewal_at: '2026-06-01 00:00:00+00',
    });
  });

  it('settles the actual invoice amount balance-neutrally and advances to invoice period boundaries', async () => {
    const user = await insertTestUser({ id: 'settlement-actual-amount-user' });
    const instanceId = '33333333-3333-4333-8333-333333333333';
    const subscriptionId = '44444444-4444-4444-8444-444444444444';

    await insertPersonalInstance({ id: instanceId, userId: user.id });
    await db.insert(kiloclaw_subscriptions).values({
      id: subscriptionId,
      user_id: user.id,
      instance_id: instanceId,
      stripe_subscription_id: 'sub_actual_amount',
      payment_source: 'stripe',
      kiloclaw_price_version: CURRENT_KILOCLAW_PRICE_VERSION,
      plan: 'standard',
      status: 'active',
      current_period_start: '2026-04-01T00:00:00.000Z',
      current_period_end: '2026-05-01T00:00:00.000Z',
    });

    const applied = await applyStripeFundedKiloClawPeriod({
      userId: user.id,
      metadataInstanceId: instanceId,
      stripeSubscriptionId: 'sub_actual_amount',
      stripePaymentId: 'in_actual_amount',
      plan: 'commit',
      priceVersion: CURRENT_KILOCLAW_PRICE_VERSION,
      amountMicrodollars: 12_340_000,
      periodStart: '2026-06-10T12:00:00.000Z',
      periodEnd: '2026-12-10T12:00:00.000Z',
    });

    expect(applied).toBe(true);
    await expect(readSubscription(subscriptionId)).resolves.toMatchObject({
      payment_source: 'credits',
      stripe_subscription_id: 'sub_actual_amount',
      plan: 'commit',
      kiloclaw_price_version: CURRENT_KILOCLAW_PRICE_VERSION,
      current_period_start: '2026-06-10 12:00:00+00',
      current_period_end: '2026-12-10 12:00:00+00',
      credit_renewal_at: '2026-12-10 12:00:00+00',
      commit_ends_at: '2026-12-10 12:00:00+00',
    });
    await expect(readUser(user.id)).resolves.toMatchObject({
      total_microdollars_acquired: 0,
    });

    const transactions = await db
      .select({ amountMicrodollars: credit_transactions.amount_microdollars })
      .from(credit_transactions)
      .where(eq(credit_transactions.kilo_user_id, user.id));
    expect(transactions.map(row => row.amountMicrodollars).sort((a, b) => a - b)).toEqual([
      -12_340_000, 12_340_000,
    ]);
  });
});
