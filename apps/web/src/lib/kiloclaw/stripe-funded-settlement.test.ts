import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { eq } from 'drizzle-orm';

import { CURRENT_KILOCLAW_PRICE_VERSION, LEGACY_KILOCLAW_PRICE_VERSION } from '@kilocode/db';
import {
  credit_transactions,
  kiloclaw_instances,
  kiloclaw_subscription_change_log,
  kiloclaw_subscriptions,
  kilocode_users,
} from '@kilocode/db/schema';
import { cleanupDbForTest, db } from '@/lib/drizzle';
import { applyStripeFundedKiloClawPeriod } from '@/lib/kiloclaw/credit-billing';
import { insertTestUser } from '@/tests/helpers/user.helper';

const makeStripeSubscriptionNonRenewing =
  jest.fn<(stripeSubscriptionId: string) => Promise<void>>();
const settlementDependencies = { makeStripeSubscriptionNonRenewing };

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
    makeStripeSubscriptionNonRenewing.mockReset();
    makeStripeSubscriptionNonRenewing.mockResolvedValue();
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

  it('allows exactly one Commit recovery at a pre-cutoff local renewal boundary', async () => {
    const user = await insertTestUser({ id: 'settlement-pre-cutoff-recovery-user' });
    const instanceId = 'bcbcbcbc-bcbc-4bcb-8bcb-bcbcbcbcbcbc';
    const subscriptionId = 'cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd';
    const stripeSubscriptionId = 'sub_pre_cutoff_recovery';

    await insertPersonalInstance({ id: instanceId, userId: user.id });
    await db.insert(kiloclaw_subscriptions).values({
      id: subscriptionId,
      user_id: user.id,
      instance_id: instanceId,
      stripe_subscription_id: stripeSubscriptionId,
      payment_source: 'stripe',
      kiloclaw_price_version: CURRENT_KILOCLAW_PRICE_VERSION,
      plan: 'commit',
      status: 'past_due',
      current_period_start: '2025-12-05T00:00:00.000Z',
      current_period_end: '2026-06-05T00:00:00.000Z',
      commit_ends_at: '2026-06-05T00:00:00.000Z',
    });

    const recovered = await applyStripeFundedKiloClawPeriod({
      userId: user.id,
      metadataInstanceId: instanceId,
      stripeSubscriptionId,
      stripePaymentId: 'in_pre_cutoff_recovery',
      plan: 'commit',
      priceVersion: CURRENT_KILOCLAW_PRICE_VERSION,
      amountMicrodollars: 306_000_000,
      periodStart: '2026-06-05T00:00:00.000Z',
      periodEnd: '2026-12-05T00:00:00.000Z',
    });
    const later = await applyStripeFundedKiloClawPeriod(
      {
        userId: user.id,
        metadataInstanceId: instanceId,
        stripeSubscriptionId,
        stripePaymentId: 'in_pre_cutoff_recovery_later',
        plan: 'commit',
        priceVersion: CURRENT_KILOCLAW_PRICE_VERSION,
        amountMicrodollars: 306_000_000,
        periodStart: '2026-12-05T00:00:00.000Z',
        periodEnd: '2027-06-05T00:00:00.000Z',
      },
      settlementDependencies
    );

    expect(recovered).toBe(true);
    expect(later).toBe(true);
    expect(makeStripeSubscriptionNonRenewing).toHaveBeenCalledWith(stripeSubscriptionId);
    await expect(readSubscription(subscriptionId)).resolves.toMatchObject({
      current_period_end: '2027-06-05 00:00:00+00',
      commit_ends_at: '2026-12-05 00:00:00+00',
      cancel_at_period_end: true,
    });
  });

  it('preserves paid access but contains a forbidden post-cutoff Commit renewal for review', async () => {
    const user = await insertTestUser({ id: 'settlement-forbidden-commit-user' });
    const instanceId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const subscriptionId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

    await insertPersonalInstance({ id: instanceId, userId: user.id });
    await db.insert(kiloclaw_subscriptions).values({
      id: subscriptionId,
      user_id: user.id,
      instance_id: instanceId,
      stripe_subscription_id: 'sub_forbidden_commit',
      payment_source: 'credits',
      kiloclaw_price_version: CURRENT_KILOCLAW_PRICE_VERSION,
      plan: 'commit',
      status: 'active',
      current_period_start: '2026-01-01T00:00:00.000Z',
      current_period_end: '2026-07-01T00:00:00.000Z',
      credit_renewal_at: '2026-07-01T00:00:00.000Z',
      commit_ends_at: '2026-07-01T00:00:00.000Z',
    });

    const providerError = new Error('provider outcome unknown');
    makeStripeSubscriptionNonRenewing.mockRejectedValueOnce(providerError);
    const settlement = applyStripeFundedKiloClawPeriod(
      {
        userId: user.id,
        metadataInstanceId: instanceId,
        stripeSubscriptionId: 'sub_forbidden_commit',
        stripePaymentId: 'in_forbidden_commit',
        plan: 'commit',
        priceVersion: CURRENT_KILOCLAW_PRICE_VERSION,
        amountMicrodollars: 306_000_000,
        periodStart: '2026-07-01T00:00:00.000Z',
        periodEnd: '2027-01-01T00:00:00.000Z',
      },
      settlementDependencies
    );

    await expect(settlement).rejects.toBe(providerError);
    await expect(readSubscription(subscriptionId)).resolves.toMatchObject({
      status: 'active',
      plan: 'commit',
      current_period_end: '2027-01-01 00:00:00+00',
      cancel_at_period_end: false,
      commit_ends_at: '2026-07-01 00:00:00+00',
    });
    expect(makeStripeSubscriptionNonRenewing).toHaveBeenCalledWith('sub_forbidden_commit');
  });

  it('requires durable explicit consent before settling Standard after final Commit', async () => {
    const user = await insertTestUser({ id: 'settlement-standard-consent-user' });
    const instanceId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    const subscriptionId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

    await insertPersonalInstance({ id: instanceId, userId: user.id });
    await db.insert(kiloclaw_subscriptions).values({
      id: subscriptionId,
      user_id: user.id,
      instance_id: instanceId,
      stripe_subscription_id: 'sub_standard_without_consent',
      payment_source: 'credits',
      kiloclaw_price_version: CURRENT_KILOCLAW_PRICE_VERSION,
      plan: 'commit',
      status: 'active',
      current_period_start: '2026-01-01T00:00:00.000Z',
      current_period_end: '2026-07-01T00:00:00.000Z',
      credit_renewal_at: '2026-07-01T00:00:00.000Z',
      commit_ends_at: '2026-07-01T00:00:00.000Z',
    });

    const applied = await applyStripeFundedKiloClawPeriod(
      {
        userId: user.id,
        metadataInstanceId: instanceId,
        stripeSubscriptionId: 'sub_standard_without_consent',
        stripePaymentId: 'in_standard_without_consent',
        plan: 'standard',
        priceVersion: CURRENT_KILOCLAW_PRICE_VERSION,
        amountMicrodollars: 55_000_000,
        periodStart: '2026-07-01T00:00:00.000Z',
        periodEnd: '2026-08-01T00:00:00.000Z',
      },
      settlementDependencies
    );

    expect(applied).toBe(true);
    expect(makeStripeSubscriptionNonRenewing).toHaveBeenCalledWith('sub_standard_without_consent');
    await expect(readSubscription(subscriptionId)).resolves.toMatchObject({
      status: 'active',
      plan: 'standard',
      current_period_end: '2026-08-01 00:00:00+00',
      cancel_at_period_end: true,
    });
  });

  it('settles explicitly consented Standard continuation and completes retirement', async () => {
    const user = await insertTestUser({ id: 'settlement-standard-consented-user' });
    const instanceId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
    const subscriptionId = 'abababab-abab-4aba-8aba-abababababab';

    await insertPersonalInstance({ id: instanceId, userId: user.id });
    await db.insert(kiloclaw_subscriptions).values({
      id: subscriptionId,
      user_id: user.id,
      instance_id: instanceId,
      stripe_subscription_id: 'sub_standard_consented',
      payment_source: 'credits',
      kiloclaw_price_version: CURRENT_KILOCLAW_PRICE_VERSION,
      plan: 'commit',
      scheduled_plan: 'standard',
      scheduled_by: 'user',
      status: 'active',
      current_period_start: '2026-01-01T00:00:00.000Z',
      current_period_end: '2026-07-01T00:00:00.000Z',
      credit_renewal_at: '2026-07-01T00:00:00.000Z',
      commit_ends_at: '2026-07-01T00:00:00.000Z',
    });

    const applied = await applyStripeFundedKiloClawPeriod({
      userId: user.id,
      metadataInstanceId: instanceId,
      stripeSubscriptionId: 'sub_standard_consented',
      stripePaymentId: 'in_standard_consented',
      plan: 'standard',
      priceVersion: CURRENT_KILOCLAW_PRICE_VERSION,
      amountMicrodollars: 55_000_000,
      periodStart: '2026-07-01T00:00:00.000Z',
      periodEnd: '2026-08-01T00:00:00.000Z',
    });

    expect(applied).toBe(true);
    await expect(readSubscription(subscriptionId)).resolves.toMatchObject({
      plan: 'standard',
      scheduled_plan: null,
      commit_ends_at: null,
    });
  });

  it('authorizes a post-cutoff first Commit settlement from verified pre-cutoff checkout evidence', async () => {
    const user = await insertTestUser({ id: 'settlement-pre-cutoff-checkout-user' });
    const instanceId = '12121212-1212-4212-8212-121212121212';
    const subscriptionId = '34343434-3434-4434-8434-343434343434';

    await insertPersonalInstance({ id: instanceId, userId: user.id });
    await db.insert(kiloclaw_subscriptions).values({
      id: subscriptionId,
      user_id: user.id,
      instance_id: instanceId,
      stripe_subscription_id: 'sub_pre_cutoff_checkout',
      payment_source: 'stripe',
      kiloclaw_price_version: CURRENT_KILOCLAW_PRICE_VERSION,
      plan: 'trial',
      status: 'trialing',
    });

    const applied = await applyStripeFundedKiloClawPeriod({
      userId: user.id,
      metadataInstanceId: instanceId,
      stripeSubscriptionId: 'sub_pre_cutoff_checkout',
      stripePaymentId: 'in_pre_cutoff_checkout',
      plan: 'commit',
      priceVersion: CURRENT_KILOCLAW_PRICE_VERSION,
      amountMicrodollars: 306_000_000,
      periodStart: '2026-06-10T00:00:00.000Z',
      periodEnd: '2026-12-10T00:00:00.000Z',
      checkoutConfirmedAt: '2026-06-05T23:59:59.000Z',
    });

    expect(applied).toBe(true);
    await expect(readSubscription(subscriptionId)).resolves.toMatchObject({
      plan: 'commit',
      commit_ends_at: '2026-12-10 00:00:00+00',
    });
  });

  it('does not infer checkout qualification when verified checkout occurred at cutoff', async () => {
    const user = await insertTestUser({ id: 'settlement-cutoff-checkout-user' });
    const instanceId = '56565656-5656-4656-8656-565656565656';
    const subscriptionId = '78787878-7878-4878-8878-787878787878';

    await insertPersonalInstance({ id: instanceId, userId: user.id });
    await db.insert(kiloclaw_subscriptions).values({
      id: subscriptionId,
      user_id: user.id,
      instance_id: instanceId,
      stripe_subscription_id: 'sub_cutoff_checkout',
      payment_source: 'stripe',
      kiloclaw_price_version: CURRENT_KILOCLAW_PRICE_VERSION,
      plan: 'trial',
      status: 'trialing',
    });

    const applied = await applyStripeFundedKiloClawPeriod(
      {
        userId: user.id,
        metadataInstanceId: instanceId,
        stripeSubscriptionId: 'sub_cutoff_checkout',
        stripePaymentId: 'in_cutoff_checkout',
        plan: 'commit',
        priceVersion: CURRENT_KILOCLAW_PRICE_VERSION,
        amountMicrodollars: 306_000_000,
        periodStart: '2026-06-10T00:00:00.000Z',
        periodEnd: '2026-12-10T00:00:00.000Z',
        checkoutConfirmedAt: '2026-06-06T00:00:00.000Z',
      },
      settlementDependencies
    );

    expect(applied).toBe(true);
    expect(makeStripeSubscriptionNonRenewing).toHaveBeenCalledWith('sub_cutoff_checkout');
    await expect(readSubscription(subscriptionId)).resolves.toMatchObject({
      plan: 'commit',
      cancel_at_period_end: true,
    });
  });

  it('does not let pre-cutoff subscription creation authorize an existing Commit renewal', async () => {
    const user = await insertTestUser({ id: 'settlement-created-renewal-user' });
    const instanceId = '91919191-9191-4191-8191-919191919191';
    const subscriptionId = '92929292-9292-4292-8292-929292929292';

    await insertPersonalInstance({ id: instanceId, userId: user.id });
    await db.insert(kiloclaw_subscriptions).values({
      id: subscriptionId,
      user_id: user.id,
      instance_id: instanceId,
      stripe_subscription_id: 'sub_created_renewal',
      payment_source: 'credits',
      kiloclaw_price_version: CURRENT_KILOCLAW_PRICE_VERSION,
      plan: 'commit',
      status: 'active',
      current_period_start: '2026-01-01T00:00:00.000Z',
      current_period_end: '2026-07-01T00:00:00.000Z',
      credit_renewal_at: '2026-07-01T00:00:00.000Z',
      commit_ends_at: '2026-07-01T00:00:00.000Z',
    });

    const applied = await applyStripeFundedKiloClawPeriod(
      {
        userId: user.id,
        metadataInstanceId: instanceId,
        stripeSubscriptionId: 'sub_created_renewal',
        stripePaymentId: 'in_created_renewal',
        plan: 'commit',
        priceVersion: CURRENT_KILOCLAW_PRICE_VERSION,
        amountMicrodollars: 306_000_000,
        periodStart: '2026-07-01T00:00:00.000Z',
        periodEnd: '2027-01-01T00:00:00.000Z',
        checkoutConfirmedAt: '2026-06-05T00:00:00.000Z',
      },
      settlementDependencies
    );

    expect(applied).toBe(true);
    expect(makeStripeSubscriptionNonRenewing).toHaveBeenCalledWith('sub_created_renewal');
    await expect(readSubscription(subscriptionId)).resolves.toMatchObject({
      current_period_end: '2027-01-01 00:00:00+00',
      commit_ends_at: '2026-07-01 00:00:00+00',
      cancel_at_period_end: true,
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
      checkoutConfirmedAt: '2026-06-05T12:00:00.000Z',
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

  it('keeps distinct payments for the same period balance-neutral', async () => {
    const user = await insertTestUser({ id: 'settlement-distinct-payment-user' });
    const instanceId = '45454545-4545-4454-8454-454545454545';
    const subscriptionId = '67676767-6767-4676-8676-676767676767';
    const stripeSubscriptionId = 'sub_distinct_payment_same_period';
    const periodStart = '2026-06-01T00:00:00.000Z';
    const periodEnd = '2026-07-01T00:00:00.000Z';

    await insertPersonalInstance({ id: instanceId, userId: user.id });
    await db.insert(kiloclaw_subscriptions).values({
      id: subscriptionId,
      user_id: user.id,
      instance_id: instanceId,
      stripe_subscription_id: stripeSubscriptionId,
      payment_source: 'credits',
      kiloclaw_price_version: CURRENT_KILOCLAW_PRICE_VERSION,
      plan: 'standard',
      status: 'active',
      current_period_start: periodStart,
      current_period_end: periodEnd,
      credit_renewal_at: periodEnd,
    });

    const settlement = {
      userId: user.id,
      metadataInstanceId: instanceId,
      stripeSubscriptionId,
      plan: 'standard',
      priceVersion: CURRENT_KILOCLAW_PRICE_VERSION,
      amountMicrodollars: 55_000_000,
      periodStart,
      periodEnd,
    } satisfies Omit<Parameters<typeof applyStripeFundedKiloClawPeriod>[0], 'stripePaymentId'>;

    await expect(
      applyStripeFundedKiloClawPeriod({
        ...settlement,
        stripePaymentId: 'ch_distinct_payment_first',
      })
    ).resolves.toBe(true);
    await expect(
      applyStripeFundedKiloClawPeriod({
        ...settlement,
        stripePaymentId: 'ch_distinct_payment_second',
      })
    ).resolves.toBe(true);

    await expect(readUser(user.id)).resolves.toMatchObject({
      total_microdollars_acquired: 0,
    });

    const transactions = await db
      .select({
        amountMicrodollars: credit_transactions.amount_microdollars,
        creditCategory: credit_transactions.credit_category,
      })
      .from(credit_transactions)
      .where(eq(credit_transactions.kilo_user_id, user.id));
    expect(transactions.map(row => row.amountMicrodollars).sort((a, b) => a - b)).toEqual([
      -55_000_000, -55_000_000, 55_000_000, 55_000_000,
    ]);
    expect(
      new Set(
        transactions
          .filter(transaction => transaction.amountMicrodollars < 0)
          .map(transaction => transaction.creditCategory)
      ).size
    ).toBe(2);
  });

  it('does not guess which duplicate payment is covered by a legacy period deduction', async () => {
    const user = await insertTestUser({ id: 'settlement-legacy-deduction-reconcile-user' });
    const instanceId = '78787878-7878-4787-8787-787878787878';
    const subscriptionId = '79797979-7979-4797-8797-797979797979';
    const stripeSubscriptionId = 'sub_legacy_deduction_reconcile';
    const firstPaymentId = 'ch_legacy_deduction_first';
    const replayedPaymentId = 'ch_legacy_deduction_second';
    const periodStart = '2026-06-01T00:00:00.000Z';
    const periodEnd = '2026-07-01T00:00:00.000Z';

    await insertPersonalInstance({ id: instanceId, userId: user.id });
    await db.insert(kiloclaw_subscriptions).values({
      id: subscriptionId,
      user_id: user.id,
      instance_id: instanceId,
      stripe_subscription_id: stripeSubscriptionId,
      payment_source: 'credits',
      kiloclaw_price_version: CURRENT_KILOCLAW_PRICE_VERSION,
      plan: 'standard',
      status: 'past_due',
      current_period_start: '2026-05-01T00:00:00.000Z',
      current_period_end: periodStart,
      credit_renewal_at: periodStart,
      past_due_since: periodStart,
    });
    await db.insert(credit_transactions).values([
      {
        kilo_user_id: user.id,
        amount_microdollars: 55_000_000,
        is_free: false,
        stripe_payment_id: firstPaymentId,
        description: 'KiloClaw standard settlement',
        created_at: '2026-06-01T00:00:00.000Z',
      },
      {
        kilo_user_id: user.id,
        amount_microdollars: 55_000_000,
        is_free: false,
        stripe_payment_id: replayedPaymentId,
        description: 'KiloClaw standard settlement',
        created_at: '2026-06-01T00:00:02.000Z',
      },
      {
        kilo_user_id: user.id,
        amount_microdollars: -55_000_000,
        is_free: false,
        credit_category: `kiloclaw-settlement:${stripeSubscriptionId}:2026-06-01`,
        check_category_uniqueness: true,
        created_at: '2026-06-01T00:00:01.000Z',
      },
    ]);
    await db.insert(kiloclaw_subscription_change_log).values({
      subscription_id: subscriptionId,
      actor_type: 'system',
      actor_id: 'kiloclaw-credit-billing',
      action: 'period_advanced',
      reason: 'stripe_invoice_settlement',
      before_state: null,
      after_state: {
        current_period_start: periodStart,
        current_period_end: periodEnd,
      },
    });
    await db
      .update(kilocode_users)
      .set({ total_microdollars_acquired: 55_000_000 })
      .where(eq(kilocode_users.id, user.id));

    await expect(
      applyStripeFundedKiloClawPeriod({
        userId: user.id,
        metadataInstanceId: instanceId,
        stripeSubscriptionId,
        stripePaymentId: replayedPaymentId,
        plan: 'standard',
        priceVersion: CURRENT_KILOCLAW_PRICE_VERSION,
        amountMicrodollars: 55_000_000,
        periodStart,
        periodEnd,
      })
    ).resolves.toBe(true);

    await expect(readUser(user.id)).resolves.toMatchObject({
      total_microdollars_acquired: 55_000_000,
    });
    await expect(readSubscription(subscriptionId)).resolves.toMatchObject({
      status: 'active',
      current_period_start: '2026-06-01 00:00:00+00',
      current_period_end: '2026-07-01 00:00:00+00',
      past_due_since: null,
    });

    const transactions = await db
      .select({
        amountMicrodollars: credit_transactions.amount_microdollars,
        creditCategory: credit_transactions.credit_category,
      })
      .from(credit_transactions)
      .where(eq(credit_transactions.kilo_user_id, user.id));
    expect(transactions.map(row => row.amountMicrodollars).sort((a, b) => a - b)).toEqual([
      -55_000_000, 55_000_000, 55_000_000,
    ]);
    expect(transactions).not.toContainEqual(
      expect.objectContaining({
        creditCategory: `kiloclaw-settlement:${stripeSubscriptionId}:payment:${replayedPaymentId}`,
      })
    );
  });

  it('does not double-deduct a replay already covered by a legacy period deduction', async () => {
    const user = await insertTestUser({ id: 'settlement-legacy-covered-replay-user' });
    const instanceId = '80808080-8080-4080-8080-808080808080';
    const subscriptionId = '85858585-8585-4585-8585-858585858585';
    const stripeSubscriptionId = 'sub_legacy_covered_replay';
    const stripePaymentId = 'ch_legacy_covered_replay';
    const periodStart = '2026-06-01T00:00:00.000Z';
    const periodEnd = '2026-07-01T00:00:00.000Z';

    await insertPersonalInstance({ id: instanceId, userId: user.id });
    await db.insert(kiloclaw_subscriptions).values({
      id: subscriptionId,
      user_id: user.id,
      instance_id: instanceId,
      stripe_subscription_id: stripeSubscriptionId,
      payment_source: 'credits',
      kiloclaw_price_version: CURRENT_KILOCLAW_PRICE_VERSION,
      plan: 'standard',
      status: 'active',
      current_period_start: periodStart,
      current_period_end: periodEnd,
      credit_renewal_at: periodEnd,
    });
    await db.insert(credit_transactions).values([
      {
        kilo_user_id: user.id,
        amount_microdollars: 55_000_000,
        is_free: false,
        stripe_payment_id: stripePaymentId,
        description: 'KiloClaw standard settlement',
      },
      {
        kilo_user_id: user.id,
        amount_microdollars: -55_000_000,
        is_free: false,
        credit_category: `kiloclaw-settlement:${stripeSubscriptionId}:2026-06-01`,
        check_category_uniqueness: true,
      },
    ]);

    await expect(
      applyStripeFundedKiloClawPeriod({
        userId: user.id,
        metadataInstanceId: instanceId,
        stripeSubscriptionId,
        stripePaymentId,
        plan: 'standard',
        priceVersion: CURRENT_KILOCLAW_PRICE_VERSION,
        amountMicrodollars: 55_000_000,
        periodStart,
        periodEnd,
      })
    ).resolves.toBe(true);

    const transactions = await db
      .select({ creditCategory: credit_transactions.credit_category })
      .from(credit_transactions)
      .where(eq(credit_transactions.kilo_user_id, user.id));
    expect(transactions).toHaveLength(2);
    expect(transactions).not.toContainEqual(
      expect.objectContaining({ creditCategory: expect.stringContaining(':payment:') })
    );
    await expect(readUser(user.id)).resolves.toMatchObject({
      total_microdollars_acquired: 0,
    });
  });

  it('does not use another subscription deposit to reconcile a legacy-covered replay', async () => {
    const user = await insertTestUser({ id: 'settlement-cross-subscription-user' });
    const firstInstanceId = '81818181-8181-4181-8181-818181818181';
    const secondInstanceId = '82828282-8282-4282-8282-828282828282';
    const firstSubscriptionId = '83838383-8383-4383-8383-838383838383';
    const secondSubscriptionId = '84848484-8484-4484-8484-848484848484';
    const firstStripeSubscriptionId = 'sub_cross_subscription_first';
    const secondStripeSubscriptionId = 'sub_cross_subscription_second';
    const periodStart = '2026-06-01T00:00:00.000Z';
    const periodEnd = '2026-07-01T00:00:00.000Z';

    await insertPersonalInstance({ id: firstInstanceId, userId: user.id });
    await insertPersonalInstance({ id: secondInstanceId, userId: user.id });
    await db.insert(kiloclaw_subscriptions).values([
      {
        id: firstSubscriptionId,
        user_id: user.id,
        instance_id: firstInstanceId,
        stripe_subscription_id: firstStripeSubscriptionId,
        payment_source: 'credits',
        kiloclaw_price_version: CURRENT_KILOCLAW_PRICE_VERSION,
        plan: 'standard',
        status: 'active',
        current_period_start: periodStart,
        current_period_end: periodEnd,
        credit_renewal_at: periodEnd,
      },
      {
        id: secondSubscriptionId,
        user_id: user.id,
        instance_id: secondInstanceId,
        stripe_subscription_id: secondStripeSubscriptionId,
        payment_source: 'credits',
        kiloclaw_price_version: CURRENT_KILOCLAW_PRICE_VERSION,
        plan: 'standard',
        status: 'past_due',
        current_period_start: '2026-05-01T00:00:00.000Z',
        current_period_end: periodStart,
        credit_renewal_at: periodStart,
      },
    ]);
    await db.insert(credit_transactions).values([
      {
        kilo_user_id: user.id,
        amount_microdollars: 55_000_000,
        is_free: false,
        stripe_payment_id: 'ch_cross_subscription_other',
        description: 'KiloClaw standard settlement',
      },
      {
        kilo_user_id: user.id,
        amount_microdollars: 55_000_000,
        is_free: false,
        stripe_payment_id: 'ch_cross_subscription_replay',
        description: 'KiloClaw standard settlement',
      },
      {
        kilo_user_id: user.id,
        amount_microdollars: -55_000_000,
        is_free: false,
        credit_category: `kiloclaw-settlement:${firstStripeSubscriptionId}:payment:ch_cross_subscription_other`,
        check_category_uniqueness: true,
      },
      {
        kilo_user_id: user.id,
        amount_microdollars: -55_000_000,
        is_free: false,
        credit_category: `kiloclaw-settlement:${secondStripeSubscriptionId}:2026-06-01`,
        check_category_uniqueness: true,
      },
    ]);

    await expect(
      applyStripeFundedKiloClawPeriod({
        userId: user.id,
        metadataInstanceId: secondInstanceId,
        stripeSubscriptionId: secondStripeSubscriptionId,
        stripePaymentId: 'ch_cross_subscription_replay',
        plan: 'standard',
        priceVersion: CURRENT_KILOCLAW_PRICE_VERSION,
        amountMicrodollars: 55_000_000,
        periodStart,
        periodEnd,
      })
    ).resolves.toBe(true);

    const deductions = await db
      .select({ creditCategory: credit_transactions.credit_category })
      .from(credit_transactions)
      .where(eq(credit_transactions.kilo_user_id, user.id));
    expect(deductions).not.toContainEqual(
      expect.objectContaining({
        creditCategory: `kiloclaw-settlement:${secondStripeSubscriptionId}:payment:ch_cross_subscription_replay`,
      })
    );
  });

  it('rolls back the deposit and subscription mutation when its deduction cannot be recorded', async () => {
    const user = await insertTestUser({ id: 'settlement-deduction-conflict-user' });
    const instanceId = '89898989-8989-4898-8989-898989898989';
    const subscriptionId = '90909090-9090-4090-8090-909090909090';
    const stripeSubscriptionId = 'sub_deduction_conflict';
    const stripePaymentId = 'ch_deduction_conflict';

    await insertPersonalInstance({ id: instanceId, userId: user.id });
    await db.insert(kiloclaw_subscriptions).values({
      id: subscriptionId,
      user_id: user.id,
      instance_id: instanceId,
      stripe_subscription_id: stripeSubscriptionId,
      payment_source: 'credits',
      kiloclaw_price_version: CURRENT_KILOCLAW_PRICE_VERSION,
      plan: 'standard',
      status: 'past_due',
      current_period_start: '2026-05-01T00:00:00.000Z',
      current_period_end: '2026-06-01T00:00:00.000Z',
      credit_renewal_at: '2026-06-01T00:00:00.000Z',
      past_due_since: '2026-06-01T00:00:00.000Z',
    });
    await db.insert(credit_transactions).values({
      kilo_user_id: user.id,
      amount_microdollars: -55_000_000,
      is_free: false,
      credit_category: `kiloclaw-settlement:${stripeSubscriptionId}:payment:${stripePaymentId}`,
      check_category_uniqueness: true,
    });

    await expect(
      applyStripeFundedKiloClawPeriod({
        userId: user.id,
        metadataInstanceId: instanceId,
        stripeSubscriptionId,
        stripePaymentId,
        plan: 'standard',
        priceVersion: CURRENT_KILOCLAW_PRICE_VERSION,
        amountMicrodollars: 55_000_000,
        periodStart: '2026-06-01T00:00:00.000Z',
        periodEnd: '2026-07-01T00:00:00.000Z',
      })
    ).rejects.toThrow('settlement deduction conflict');

    await expect(readUser(user.id)).resolves.toMatchObject({
      total_microdollars_acquired: 0,
    });
    await expect(readSubscription(subscriptionId)).resolves.toMatchObject({
      status: 'past_due',
      current_period_start: '2026-05-01 00:00:00+00',
      current_period_end: '2026-06-01 00:00:00+00',
      past_due_since: '2026-06-01 00:00:00+00',
    });

    const transactions = await db
      .select()
      .from(credit_transactions)
      .where(eq(credit_transactions.kilo_user_id, user.id));
    expect(transactions).toHaveLength(1);
    expect(transactions[0]?.stripe_payment_id).toBeNull();
  });
});
