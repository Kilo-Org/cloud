import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { eq } from 'drizzle-orm';

import {
  createCommitRetirementReviewCase,
  CURRENT_KILOCLAW_PRICE_VERSION,
  KiloClawCommitRetirementResolutionActorType,
  KiloClawCommitRetirementResolutionDisposition,
  KiloClawCommitRetirementReviewCaseStatus,
  KiloClawCommitRetirementReviewReason,
  LEGACY_KILOCLAW_PRICE_VERSION,
  resolveCommitRetirementReviewCase,
} from '@kilocode/db';
import {
  credit_transactions,
  kiloclaw_commit_retirement_review_cases,
  kiloclaw_instances,
  kiloclaw_subscriptions,
  kilocode_users,
} from '@kilocode/db/schema';
import { cleanupDbForTest, db } from '@/lib/drizzle';
import { applyStripeFundedKiloClawPeriod } from '@/lib/kiloclaw/credit-billing';
import { insertTestUser } from '@/tests/helpers/user.helper';

type StripeRetrieveMockResult = {
  id: string;
  schedule: string | null;
  cancel_at_period_end: boolean;
  items: { data: unknown[] };
};

const stripeRetrieveMock = jest.fn<(id: string) => Promise<StripeRetrieveMockResult>>();
const stripeUpdateMock = jest.fn<() => Promise<unknown>>();
const stripeScheduleReleaseMock = jest.fn<() => Promise<unknown>>();

jest.mock('@/lib/stripe-client', () => ({
  client: {
    subscriptions: { retrieve: stripeRetrieveMock, update: stripeUpdateMock },
    subscriptionSchedules: { release: stripeScheduleReleaseMock },
  },
}));

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
    stripeRetrieveMock.mockReset();
    stripeUpdateMock.mockReset();
    stripeScheduleReleaseMock.mockReset();
    stripeRetrieveMock.mockImplementation(async (id: string) => ({
      id,
      schedule: null,
      cancel_at_period_end: true,
      items: { data: [] },
    }));
    stripeUpdateMock.mockResolvedValue({});
    stripeScheduleReleaseMock.mockResolvedValue({});
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
    const later = await applyStripeFundedKiloClawPeriod({
      userId: user.id,
      metadataInstanceId: instanceId,
      stripeSubscriptionId,
      stripePaymentId: 'in_pre_cutoff_recovery_later',
      plan: 'commit',
      priceVersion: CURRENT_KILOCLAW_PRICE_VERSION,
      amountMicrodollars: 306_000_000,
      periodStart: '2026-12-05T00:00:00.000Z',
      periodEnd: '2027-06-05T00:00:00.000Z',
    });

    expect(recovered).toBe(true);
    expect(later).toBe(true);
    await expect(readSubscription(subscriptionId)).resolves.toMatchObject({
      current_period_end: '2027-06-05 00:00:00+00',
      commit_retirement_final_ends_at: '2026-12-05 00:00:00+00',
      commit_retirement_state: 'manual_review',
      cancel_at_period_end: true,
    });
  });

  it('opens a new same-reason review episode after an earlier case was resolved', async () => {
    const user = await insertTestUser({ id: 'settlement-repeated-review-user' });
    const instanceId = 'a1a1a1a1-a1a1-41a1-81a1-a1a1a1a1a1a1';
    const subscriptionId = 'b2b2b2b2-b2b2-42b2-82b2-b2b2b2b2b2b2';
    const stripeSubscriptionId = 'sub_repeated_review';

    await insertPersonalInstance({ id: instanceId, userId: user.id });
    await db.insert(kiloclaw_subscriptions).values({
      id: subscriptionId,
      user_id: user.id,
      instance_id: instanceId,
      stripe_subscription_id: stripeSubscriptionId,
      payment_source: 'credits',
      kiloclaw_price_version: CURRENT_KILOCLAW_PRICE_VERSION,
      plan: 'commit',
      status: 'active',
      current_period_start: '2026-01-01T00:00:00.000Z',
      current_period_end: '2026-07-01T00:00:00.000Z',
      credit_renewal_at: '2026-07-01T00:00:00.000Z',
      commit_ends_at: '2026-07-01T00:00:00.000Z',
      commit_retirement_state: 'final_term',
      commit_retirement_final_ends_at: '2026-07-01T00:00:00.000Z',
    });
    const firstDedupeKey = `commit-retirement:forbidden_commit_invoice:${subscriptionId}:episode:1`;
    await createCommitRetirementReviewCase(db, {
      dedupeKey: firstDedupeKey,
      subscriptionId,
      stripeSubscriptionId,
      reasonCode: KiloClawCommitRetirementReviewReason.ForbiddenCommitInvoice,
      summary: 'Earlier forbidden Commit invoice review.',
    });
    await resolveCommitRetirementReviewCase(db, {
      dedupeKey: firstDedupeKey,
      status: KiloClawCommitRetirementReviewCaseStatus.Resolved,
      disposition: KiloClawCommitRetirementResolutionDisposition.CorrectState,
      actor: { type: KiloClawCommitRetirementResolutionActorType.System, id: 'test' },
      resolvedAt: '2026-07-02T00:00:00.000Z',
      reason: 'Earlier issue resolved.',
    });

    const applied = await applyStripeFundedKiloClawPeriod({
      userId: user.id,
      metadataInstanceId: instanceId,
      stripeSubscriptionId,
      stripePaymentId: 'in_repeated_review',
      plan: 'commit',
      priceVersion: CURRENT_KILOCLAW_PRICE_VERSION,
      amountMicrodollars: 306_000_000,
      periodStart: '2026-07-01T00:00:00.000Z',
      periodEnd: '2027-01-01T00:00:00.000Z',
    });

    const retried = await applyStripeFundedKiloClawPeriod({
      userId: user.id,
      metadataInstanceId: instanceId,
      stripeSubscriptionId,
      stripePaymentId: 'in_repeated_review_retry',
      plan: 'commit',
      priceVersion: CURRENT_KILOCLAW_PRICE_VERSION,
      amountMicrodollars: 306_000_000,
      periodStart: '2027-01-01T00:00:00.000Z',
      periodEnd: '2027-07-01T00:00:00.000Z',
    });

    expect(applied).toBe(true);
    expect(retried).toBe(true);
    await expect(readSubscription(subscriptionId)).resolves.toMatchObject({
      commit_retirement_state: 'manual_review',
      cancel_at_period_end: true,
    });
    const reviewCases = await db
      .select()
      .from(kiloclaw_commit_retirement_review_cases)
      .where(eq(kiloclaw_commit_retirement_review_cases.subscription_id, subscriptionId));
    expect(reviewCases).toHaveLength(2);
    expect(reviewCases).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ dedupe_key: firstDedupeKey, status: 'resolved' }),
        expect.objectContaining({
          dedupe_key: `commit-retirement:forbidden_commit_invoice:${subscriptionId}:episode:2`,
          status: 'open',
          reason_code: 'forbidden_commit_invoice',
        }),
      ])
    );
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
      commit_retirement_state: 'final_term',
      commit_retirement_final_ends_at: '2026-07-01T00:00:00.000Z',
    });

    const applied = await applyStripeFundedKiloClawPeriod({
      userId: user.id,
      metadataInstanceId: instanceId,
      stripeSubscriptionId: 'sub_forbidden_commit',
      stripePaymentId: 'in_forbidden_commit',
      plan: 'commit',
      priceVersion: CURRENT_KILOCLAW_PRICE_VERSION,
      amountMicrodollars: 306_000_000,
      periodStart: '2026-07-01T00:00:00.000Z',
      periodEnd: '2027-01-01T00:00:00.000Z',
    });

    expect(applied).toBe(true);
    await expect(readSubscription(subscriptionId)).resolves.toMatchObject({
      status: 'active',
      plan: 'commit',
      current_period_end: '2027-01-01 00:00:00+00',
      cancel_at_period_end: true,
      commit_retirement_state: 'manual_review',
      commit_retirement_final_ends_at: '2026-07-01 00:00:00+00',
      commit_retirement_review_reason: 'forbidden_commit_invoice',
    });
    await expect(
      db
        .select()
        .from(kiloclaw_commit_retirement_review_cases)
        .where(eq(kiloclaw_commit_retirement_review_cases.subscription_id, subscriptionId))
    ).resolves.toHaveLength(1);
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
      commit_retirement_state: 'final_term',
      commit_retirement_final_ends_at: '2026-07-01T00:00:00.000Z',
    });

    const applied = await applyStripeFundedKiloClawPeriod({
      userId: user.id,
      metadataInstanceId: instanceId,
      stripeSubscriptionId: 'sub_standard_without_consent',
      stripePaymentId: 'in_standard_without_consent',
      plan: 'standard',
      priceVersion: CURRENT_KILOCLAW_PRICE_VERSION,
      amountMicrodollars: 55_000_000,
      periodStart: '2026-07-01T00:00:00.000Z',
      periodEnd: '2026-08-01T00:00:00.000Z',
    });

    expect(applied).toBe(true);
    await expect(readSubscription(subscriptionId)).resolves.toMatchObject({
      status: 'active',
      plan: 'standard',
      current_period_end: '2026-08-01 00:00:00+00',
      cancel_at_period_end: true,
      commit_retirement_state: 'manual_review',
      commit_retirement_review_reason: 'provider_state_mismatch',
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
      commit_retirement_state: 'standard_scheduled',
      commit_retirement_final_ends_at: '2026-07-01T00:00:00.000Z',
      commit_retirement_standard_opted_in_at: '2026-06-10T00:00:00.000Z',
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
      commit_retirement_state: 'completed',
      commit_retirement_review_reason: null,
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
      commit_retirement_state: 'final_term',
      commit_retirement_final_ends_at: '2026-12-10 00:00:00+00',
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

    const applied = await applyStripeFundedKiloClawPeriod({
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
    });

    expect(applied).toBe(true);
    await expect(readSubscription(subscriptionId)).resolves.toMatchObject({
      plan: 'commit',
      cancel_at_period_end: true,
      commit_retirement_state: 'manual_review',
      commit_retirement_review_reason: 'forbidden_commit_invoice',
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
      commit_retirement_state: 'final_term',
      commit_retirement_final_ends_at: '2026-07-01T00:00:00.000Z',
    });

    const applied = await applyStripeFundedKiloClawPeriod({
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
    });

    expect(applied).toBe(true);
    await expect(readSubscription(subscriptionId)).resolves.toMatchObject({
      current_period_end: '2027-01-01 00:00:00+00',
      commit_retirement_final_ends_at: '2026-07-01 00:00:00+00',
      commit_retirement_state: 'manual_review',
      cancel_at_period_end: true,
    });
  });

  it('ingests a rowless recognize-paid-final disposition once and blocks later periods', async () => {
    const user = await insertTestUser({ id: 'settlement-rowless-final-user' });
    const instanceId = '93939393-9393-4393-8393-939393939393';
    const subscriptionId = '94949494-9494-4494-8494-949494949494';
    const stripeSubscriptionId = 'sub_rowless_recognized_final';
    const dedupeKey = 'commit-retirement:rowless-recognized-final';

    await insertPersonalInstance({ id: instanceId, userId: user.id });
    await db.insert(kiloclaw_subscriptions).values({
      id: subscriptionId,
      user_id: user.id,
      instance_id: instanceId,
      payment_source: 'stripe',
      kiloclaw_price_version: CURRENT_KILOCLAW_PRICE_VERSION,
      plan: 'trial',
      status: 'trialing',
    });
    await createCommitRetirementReviewCase(db, {
      dedupeKey,
      stripeSubscriptionId,
      reasonCode: KiloClawCommitRetirementReviewReason.UnqualifiedPostCutoffCommit,
      summary: 'Recognize one already-paid rowless Commit period as final.',
    });
    await resolveCommitRetirementReviewCase(db, {
      dedupeKey,
      status: KiloClawCommitRetirementReviewCaseStatus.Resolved,
      disposition: KiloClawCommitRetirementResolutionDisposition.RecognizePaidPeriodAsFinal,
      actor: { type: KiloClawCommitRetirementResolutionActorType.System, id: 'test' },
      resolvedAt: '2026-06-07T00:00:00.000Z',
      reason: 'Paid access must be preserved once.',
    });
    stripeRetrieveMock.mockResolvedValue({
      id: stripeSubscriptionId,
      schedule: null,
      cancel_at_period_end: true,
      items: { data: [] },
    });

    const firstApplied = await applyStripeFundedKiloClawPeriod({
      userId: user.id,
      metadataInstanceId: instanceId,
      stripeSubscriptionId,
      stripePaymentId: 'in_rowless_recognized_final',
      plan: 'commit',
      priceVersion: CURRENT_KILOCLAW_PRICE_VERSION,
      amountMicrodollars: 306_000_000,
      periodStart: '2026-06-10T00:00:00.000Z',
      periodEnd: '2026-12-10T00:00:00.000Z',
    });
    const laterApplied = await applyStripeFundedKiloClawPeriod({
      userId: user.id,
      metadataInstanceId: instanceId,
      stripeSubscriptionId,
      stripePaymentId: 'in_rowless_recognized_later',
      plan: 'commit',
      priceVersion: CURRENT_KILOCLAW_PRICE_VERSION,
      amountMicrodollars: 306_000_000,
      periodStart: '2026-12-10T00:00:00.000Z',
      periodEnd: '2027-06-10T00:00:00.000Z',
    });

    expect(firstApplied).toBe(true);
    expect(laterApplied).toBe(false);
    await expect(readSubscription(subscriptionId)).resolves.toMatchObject({
      plan: 'commit',
      current_period_end: '2026-12-10 00:00:00+00',
      commit_retirement_state: 'manual_review',
      commit_retirement_final_ends_at: '2026-12-10 00:00:00+00',
      commit_retirement_review_reason: 'provider_outcome_unknown',
      cancel_at_period_end: true,
    });
    const transactions = await db
      .select()
      .from(credit_transactions)
      .where(eq(credit_transactions.kilo_user_id, user.id));
    expect(transactions).toHaveLength(2);
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
      commit_retirement_state: 'pending_final_term',
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
