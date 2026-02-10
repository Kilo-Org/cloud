import { describe, test, expect, beforeEach, jest } from '@jest/globals';
import {
  type StripeTopupMetadata,
  ensurePaymentMethodStored,
  processStripePaymentEventHook,
  handleSuccessfulChargeWithPayment,
  isCardFingerprintEligibleForFreeCredits,
} from '@/lib/stripe';
import {
  type User,
  payment_methods,
  credit_transactions,
  kilo_pass_audit_log,
  kilo_pass_scheduled_changes,
  kilo_pass_subscriptions,
  organizations,
  kilocode_users,
  auto_top_up_configs,
} from '@/db/schema';
import { db, auto_deleted_at } from '@/lib/drizzle';
import { insertTestUser } from './helpers/user.helper';
import { createTestPaymentMethod } from './helpers/payment-method.helper';
import { eq, and, count } from 'drizzle-orm';
import type Stripe from 'stripe';
import { createOrganization } from '@/lib/organizations/organizations';
import { FIRST_TOPUP_BONUS_AMOUNT } from '@/lib/constants';
import { releaseScheduledChangeForSubscription } from '@/lib/kilo-pass/scheduled-change-release';
import {
  KiloPassCadence,
  KiloPassScheduledChangeStatus,
  KiloPassTier,
} from '@/lib/kilo-pass/enums';
import { cleanupDbForTest } from '@/lib/drizzle';

const sampleStripePaymentMethod = (): Stripe.PaymentMethod => ({
  id: `pm_test_${Math.random().toString(36).substring(7)}`,
  object: 'payment_method',
  billing_details: {
    address: null,
    email: null,
    name: null,
    phone: null,
    tax_id: null,
  },
  card: sampleStripeCard(),
  created: 1234567890,
  customer: null,
  livemode: false,
  metadata: {},
  type: 'card',
});

const sampleStripeCard = (): Stripe.PaymentMethod.Card => ({
  brand: 'visa',
  checks: {
    address_line1_check: null,
    address_postal_code_check: null,
    cvc_check: null,
  },
  country: 'US',
  exp_month: 12,
  exp_year: 2025,
  fingerprint: `test_fingerprint_${Math.random().toString(36).substring(7)}`,
  funding: 'credit',
  generated_from: null,
  last4: '4242',
  networks: {
    available: ['visa'],
    preferred: null,
  },
  three_d_secure_usage: {
    supported: true,
  },
  wallet: null,
  display_brand: 'Visa',
  regulated_status: 'unregulated',
});

const sampleStripePaymentIntent = (): Stripe.PaymentIntent => ({
  id: 'pi_test_123',
  object: 'payment_intent',
  amount: 1000,
  amount_capturable: 0,
  amount_received: 1000,
  application: null,
  application_fee_amount: null,
  automatic_payment_methods: null,
  canceled_at: null,
  cancellation_reason: null,
  capture_method: 'automatic',
  client_secret: 'pi_test_123_secret_test',
  confirmation_method: 'automatic',
  created: 1234567890,
  currency: 'usd',
  customer: null,
  description: null,
  last_payment_error: null,
  latest_charge: null,
  livemode: false,
  metadata: {},
  next_action: null,
  on_behalf_of: null,
  payment_method: null,
  payment_method_configuration_details: null,
  payment_method_options: null,
  payment_method_types: ['card'],
  processing: null,
  receipt_email: null,
  review: null,
  setup_future_usage: null,
  shipping: null,
  source: null,
  statement_descriptor: null,
  statement_descriptor_suffix: null,
  status: 'succeeded',
  transfer_data: null,
  transfer_group: null,
  excluded_payment_method_types: null,
});

const baseStripeEvent = () => ({
  id: Math.random().toString(36).substring(7),
  object: 'event' as const,
  api_version: '2023-10-16',
  created: 1234567890,

  livemode: false,
  pending_webhooks: 0,
  request: null,
});

describe('ensurePaymentMethodStored', () => {
  let testUser: User;
  let mockStripePaymentMethod: Stripe.PaymentMethod;

  beforeEach(async () => {
    testUser = await insertTestUser();
    mockStripePaymentMethod = sampleStripePaymentMethod();
    mockStripePaymentMethod.customer = testUser.stripe_customer_id;
  });

  test('should create a new payment method when it does not exist', async () => {
    const headers = {
      http_x_forwarded_for: '192.168.1.1',
      http_x_vercel_ip_city: 'San Francisco',
      http_x_vercel_ip_country: 'US',
      http_x_vercel_ip_latitude: 37.7749,
      http_x_vercel_ip_longitude: -122.4194,
      http_x_vercel_ja4_digest: 'test_digest',
      http_user_agent: 'Mozilla/5.0 (test)',
      machine_id: null,
    };

    const result = await ensurePaymentMethodStored(testUser.id, mockStripePaymentMethod, headers);

    expect(result).not.toBeNull();
    expect(result?.user_id).toBe(testUser.id);
    expect(result?.stripe_id).toBe(mockStripePaymentMethod.id);
    expect(result?.stripe_fingerprint).toBe(mockStripePaymentMethod.card?.fingerprint);
    expect(result?.last4).toBe('4242');
    expect(result?.brand).toBe('visa');
    expect(result?.type).toBe('card');
    expect(result?.eligible_for_free_credits).toBe(true);
    expect(result?.http_x_forwarded_for).toBe(headers.http_x_forwarded_for);
    expect(result?.http_x_vercel_ip_city).toBe(headers.http_x_vercel_ip_city);
    expect(result?.http_x_vercel_ip_country).toBe(headers.http_x_vercel_ip_country);
    expect(result?.http_x_vercel_ip_latitude).toBe(headers.http_x_vercel_ip_latitude);
    expect(result?.http_x_vercel_ip_longitude).toBe(headers.http_x_vercel_ip_longitude);
    expect(result?.http_x_vercel_ja4_digest).toBe(headers.http_x_vercel_ja4_digest);
  });

  // This test verifies that when directly calling ensurePaymentMethodStored with a payment method
  // that already exists in the database but is soft-deleted, it will restore the payment method
  // and update its data with the latest information from Stripe
  test('should restore a soft-deleted payment method when directly storing the same payment method', async () => {
    const existingPaymentMethod = {
      ...createTestPaymentMethod(testUser.id),
      stripe_id: mockStripePaymentMethod.id,
      stripe_fingerprint: mockStripePaymentMethod.card?.fingerprint ?? undefined,
      last4: '1111', // Old value
      brand: 'mastercard', // Old value
      deleted_at: new Date().toISOString(), // Soft deleted
    };
    const insertResult = await db.insert(payment_methods).values(existingPaymentMethod).returning();
    const insertedPaymentMethod = insertResult[0];

    const result = await ensurePaymentMethodStored(testUser.id, mockStripePaymentMethod);

    expect(result).not.toBeNull();
    expect(result?.id).toBe(insertedPaymentMethod.id);
    expect(result?.deleted_at).toBeNull(); // Should be restored
    expect(result?.last4).toBe('4242'); // Should be updated
    expect(result?.brand).toBe('visa'); // Should be updated
    expect(result?.stripe_data).toEqual(mockStripePaymentMethod); // Should be updated
    expect(result?.eligible_for_free_credits).toBe(true); // Should remain true
  });

  test('should set eligible_for_free_credits to false when fingerprint is already used by another user', async () => {
    const anotherUser = await insertTestUser();
    const otherMockPaymentMethod = {
      ...mockStripePaymentMethod,
      id: 'pm_other_123',
    };
    const existingPaymentMethod = {
      ...createTestPaymentMethod(anotherUser.id),
      stripe_id: otherMockPaymentMethod.id,
      stripe_fingerprint: otherMockPaymentMethod.card?.fingerprint ?? undefined,
    };
    await db.insert(payment_methods).values(existingPaymentMethod);

    const result = await ensurePaymentMethodStored(testUser.id, mockStripePaymentMethod);

    expect(result).not.toBeNull();
    expect(result?.eligible_for_free_credits).toBe(false);
  });

  test('should set eligible_for_free_credits to false when card has no fingerprint', async () => {
    if (mockStripePaymentMethod.card) {
      mockStripePaymentMethod.card.fingerprint = null;
    }

    const result = await ensurePaymentMethodStored(testUser.id, mockStripePaymentMethod);

    expect(result).not.toBeNull();
    expect(result?.eligible_for_free_credits).toBe(false);
    expect(result?.stripe_fingerprint).toBeNull();
  });

  test('should handle payment methods without card data', async () => {
    mockStripePaymentMethod.card = undefined;
    mockStripePaymentMethod.type = 'bank_account' as Stripe.PaymentMethod.Type;

    const result = await ensurePaymentMethodStored(
      testUser.id,
      mockStripePaymentMethod as unknown as Stripe.PaymentMethod
    );

    expect(result).not.toBeNull();
    expect(result?.stripe_fingerprint).toBeNull();
    expect(result?.last4).toBeNull();
    expect(result?.brand).toBeNull();
    expect(result?.three_d_secure_supported).toBeNull();
    expect(result?.type).toBe('bank_account');
    expect(result?.eligible_for_free_credits).toBe(false);
  });

  test('should handle missing and partial headers gracefully', async () => {
    const resultMissing = await ensurePaymentMethodStored(testUser.id, mockStripePaymentMethod);

    expect(resultMissing).not.toBeNull();
    expect(resultMissing?.http_x_forwarded_for).toBeNull();
    expect(resultMissing?.http_x_vercel_ip_city).toBeNull();
    expect(resultMissing?.http_x_vercel_ip_country).toBeNull();
    expect(resultMissing?.http_x_vercel_ip_latitude).toBeNull();
    expect(resultMissing?.http_x_vercel_ip_longitude).toBeNull();
    expect(resultMissing?.http_x_vercel_ja4_digest).toBeNull();

    const partialHeaders = {
      http_x_forwarded_for: '192.168.1.1',
      http_x_vercel_ip_city: null,
      http_x_vercel_ip_country: 'US',
      http_x_vercel_ip_latitude: null,
      http_x_vercel_ip_longitude: null,
      http_x_vercel_ja4_digest: null,
      http_user_agent: null,
      machine_id: null,
    };

    const uniquePaymentMethod = sampleStripePaymentMethod();
    uniquePaymentMethod.id = 'pm_test_partial_headers_' + Math.random();
    uniquePaymentMethod.customer = testUser.stripe_customer_id;

    const resultPartial = await ensurePaymentMethodStored(
      testUser.id,
      uniquePaymentMethod,
      partialHeaders
    );

    expect(resultPartial).not.toBeNull();
    expect(resultPartial?.http_x_forwarded_for).toBe('192.168.1.1');
    expect(resultPartial?.http_x_vercel_ip_city).toBeNull();
    expect(resultPartial?.http_x_vercel_ip_country).toBe('US');
    expect(resultPartial?.http_x_vercel_ip_latitude).toBeNull();
    expect(resultPartial?.http_x_vercel_ip_longitude).toBeNull();
    expect(resultPartial?.http_x_vercel_ja4_digest).toBeNull();
  });

  test('should capture exception and return null on database error', async () => {
    const uniquePaymentMethod = sampleStripePaymentMethod();
    uniquePaymentMethod.customer = testUser.stripe_customer_id;
    uniquePaymentMethod.id = null!;
    const result = await ensurePaymentMethodStored(testUser.id, uniquePaymentMethod);
    expect(result).toBeNull();
  });

  test('should handle unique constraint violation gracefully', async () => {
    mockStripePaymentMethod.id = 'pm_test_unique_constraint_' + Math.random();
    if (mockStripePaymentMethod.card) {
      mockStripePaymentMethod.card.last4 = '1111';
      mockStripePaymentMethod.card.brand = 'mastercard';
    }

    await ensurePaymentMethodStored(testUser.id, mockStripePaymentMethod);

    // For the updated payment method, we need to modify the same object
    // since we're simulating an update to the same payment method ID
    if (mockStripePaymentMethod.card) {
      mockStripePaymentMethod.card.last4 = '2222';
      mockStripePaymentMethod.card.brand = 'amex';
    }

    const result = await ensurePaymentMethodStored(testUser.id, mockStripePaymentMethod);

    expect(result).not.toBeNull();
    expect(result?.stripe_id).toBe(mockStripePaymentMethod.id);
    expect(result?.last4).toBe('2222');
    expect(result?.brand).toBe('amex');
  });

  test('should correctly check for existing fingerprints across deleted records', async () => {
    mockStripePaymentMethod.id = 'pm_deleted_123';

    const storedMethod = await ensurePaymentMethodStored(testUser.id, mockStripePaymentMethod);
    expect(storedMethod).not.toBeNull();
    await db
      .update(payment_methods)
      .set({ ...auto_deleted_at })
      .where(eq(payment_methods.id, storedMethod!.id));

    const userB = await insertTestUser();
    const userB_card = sampleStripePaymentMethod();
    userB_card.id = 'pm_test_deleted_check';
    userB_card.card!.fingerprint = mockStripePaymentMethod.card!.fingerprint; // Same fingerprint as userA
    userB_card.customer = userB.stripe_customer_id;

    const result = await ensurePaymentMethodStored(userB.id, userB_card);

    expect(result).not.toBeNull();
    // Should still be false because we check withDeleted: true
    expect(result?.eligible_for_free_credits).toBe(false);
  });

  test('should handle complex card data correctly', async () => {
    mockStripePaymentMethod.card = {
      ...sampleStripeCard(),
      three_d_secure_usage: {
        supported: false,
      },
      funding: 'debit',
      checks: {
        address_line1_check: 'pass',
        address_postal_code_check: 'fail',
        cvc_check: 'unavailable',
      },
      regulated_status: 'regulated',
    };
    mockStripePaymentMethod.billing_details = {
      address: {
        city: 'New York',
        country: 'US',
        line1: '123 Main St',
        line2: 'Apt 4B',
        postal_code: '10001',
        state: 'NY',
      },
      email: 'test@example.com',
      name: 'John Doe',
      phone: '+1234567890',
      tax_id: null,
    };

    const result = await ensurePaymentMethodStored(testUser.id, mockStripePaymentMethod);

    expect(result).not.toBeNull();
    expect(result?.three_d_secure_supported).toBe(false);
    expect(result?.funding).toBe('debit');
    expect(result?.address_line1_check_status).toBe('pass');
    expect(result?.postal_code_check_status).toBe('fail');
    expect(result?.address_line1).toBe('123 Main St');
    expect(result?.address_line2).toBe('Apt 4B');
    expect(result?.address_city).toBe('New York');
    expect(result?.address_state).toBe('NY');
    expect(result?.address_zip).toBe('10001');
    expect(result?.address_country).toBe('US');
    expect(result?.name).toBe('John Doe');
    expect(result?.regulated_status).toBe('regulated');
    expect(result?.stripe_data).toEqual(mockStripePaymentMethod);

    await db.delete(payment_methods).where(eq(payment_methods.user_id, testUser.id));
  });
});

describe('processStripePaymentEventHook', () => {
  let testUser: User;
  let mockStripePaymentMethod: Stripe.PaymentMethod;

  beforeEach(async () => {
    testUser = await insertTestUser();
    mockStripePaymentMethod = sampleStripePaymentMethod();
    mockStripePaymentMethod.customer = testUser.stripe_customer_id!;
  });

  test('should handle payment_method.attached event', async () => {
    const event: Stripe.Event = {
      id: 'evt_test_attached',
      object: 'event',
      api_version: '2023-10-16',
      created: 1234567890,
      data: {
        object: mockStripePaymentMethod,
        previous_attributes: {},
      },
      livemode: false,
      pending_webhooks: 0,
      request: null,
      type: 'payment_method.attached',
    };

    await processStripePaymentEventHook(event);

    const storedPaymentMethod = await db.query.payment_methods.findFirst({
      where: and(
        eq(payment_methods.stripe_id, mockStripePaymentMethod.id),
        eq(payment_methods.user_id, testUser.id)
      ),
    });

    expect(storedPaymentMethod).not.toBeNull();
    expect(storedPaymentMethod?.stripe_id).toBe(mockStripePaymentMethod.id);
    expect(storedPaymentMethod?.user_id).toBe(testUser.id);
  });

  test('should handle payment_method.updated event', async () => {
    await ensurePaymentMethodStored(testUser.id, mockStripePaymentMethod);

    mockStripePaymentMethod.card!.last4 = '9999';
    mockStripePaymentMethod.card!.brand = 'amex';

    const event: Stripe.Event = {
      ...baseStripeEvent(),
      data: {
        object: mockStripePaymentMethod,
        previous_attributes: {},
      },
      type: 'payment_method.updated',
    };

    await processStripePaymentEventHook(event);

    const storedPaymentMethod = await db.query.payment_methods.findFirst({
      where: and(
        eq(payment_methods.stripe_id, mockStripePaymentMethod.id),
        eq(payment_methods.user_id, testUser.id)
      ),
    });

    expect(storedPaymentMethod).not.toBeNull();
    expect(storedPaymentMethod?.last4).toBe('9999');
    expect(storedPaymentMethod?.brand).toBe('amex');
  });

  test('should handle payment_method.detached event', async () => {
    const existingPaymentMethod = {
      ...createTestPaymentMethod(testUser.id),
      stripe_id: mockStripePaymentMethod.id,
      stripe_fingerprint: mockStripePaymentMethod.card?.fingerprint ?? undefined,
    };
    await db.insert(payment_methods).values(existingPaymentMethod);

    const event: Stripe.Event = {
      ...baseStripeEvent(),
      data: {
        object: mockStripePaymentMethod,
        previous_attributes: {},
      },
      type: 'payment_method.detached',
    };

    await processStripePaymentEventHook(event);

    const storedPaymentMethod = await db.query.payment_methods.findMany({
      where: and(eq(payment_methods.user_id, testUser.id)),
    });

    expect(storedPaymentMethod.length).toBe(1);
    expect(storedPaymentMethod[0].deleted_at).not.toBeNull();
  });

  test('should handle payment_intent.succeeded event by ignoring it', async () => {
    const event: Stripe.Event = {
      ...baseStripeEvent(),
      data: {
        object: sampleStripePaymentIntent(),
        previous_attributes: {},
      },
      type: 'payment_intent.succeeded',
    };

    await processStripePaymentEventHook(event);

    const paymentMethodExists = await db.query.payment_methods.findFirst({
      where: eq(payment_methods.user_id, testUser.id),
    });

    expect(paymentMethodExists).toBeUndefined();
  });

  test('should handle missing user gracefully', async () => {
    mockStripePaymentMethod.customer = 'cus_nonexistent';

    const event: Stripe.Event = {
      ...baseStripeEvent(),
      data: {
        object: mockStripePaymentMethod,
        previous_attributes: {},
      },
      type: 'payment_method.attached',
    };

    await processStripePaymentEventHook(event);

    const paymentMethodExists = await db.query.payment_methods.findFirst({
      where: eq(payment_methods.stripe_id, mockStripePaymentMethod.id),
    });

    expect(paymentMethodExists).toBeUndefined();
  });

  test('should handle null customer gracefully', async () => {
    mockStripePaymentMethod.customer = null;

    const event: Stripe.Event = {
      ...baseStripeEvent(),
      data: {
        object: mockStripePaymentMethod,
        previous_attributes: {},
      },
      type: 'payment_method.attached',
    };

    await processStripePaymentEventHook(event);

    const paymentMethodExists = await db.query.payment_methods.findFirst({
      where: eq(payment_methods.stripe_id, mockStripePaymentMethod.id),
    });

    expect(paymentMethodExists).toBeUndefined();
  });

  describe('subscription_schedule.* (Kilo Pass scheduled changes)', () => {
    test('subscription_schedule.updated does not issue remaining base credits', async () => {
      const stripeSubscriptionId = `sub_kilo_pass_yearly_${Math.random()}`;
      const scheduleId = `sub_sched_${Math.random()}`;
      const scheduledChangeId = crypto.randomUUID();

      const startedAt = '2026-01-01T00:00:00.000Z';
      const effectiveAt = '2026-04-01T00:00:00.000Z';

      await db.insert(kilo_pass_subscriptions).values({
        kilo_user_id: testUser.id,
        stripe_subscription_id: stripeSubscriptionId,
        tier: KiloPassTier.Tier49,
        cadence: KiloPassCadence.Yearly,
        status: 'active',
        cancel_at_period_end: false,
        started_at: startedAt,
        ended_at: null,
        current_streak_months: 0,
        next_yearly_issue_at: '2026-02-01T00:00:00.000Z',
      });

      await db.insert(kilo_pass_scheduled_changes).values({
        id: scheduledChangeId,
        kilo_user_id: testUser.id,
        stripe_subscription_id: stripeSubscriptionId,
        from_tier: KiloPassTier.Tier49,
        from_cadence: KiloPassCadence.Yearly,
        to_tier: KiloPassTier.Tier49,
        to_cadence: KiloPassCadence.Monthly,
        stripe_schedule_id: scheduleId,
        effective_at: effectiveAt,
        status: KiloPassScheduledChangeStatus.NotStarted,
      });

      const event: Stripe.Event = {
        ...baseStripeEvent(),
        id: `evt_sched_updated_${Math.random()}`,
        type: 'subscription_schedule.updated',
        data: {
          object: {
            id: scheduleId,
            status: KiloPassScheduledChangeStatus.NotStarted,
          } as unknown as Stripe.SubscriptionSchedule,
          previous_attributes: {},
        },
      };

      await processStripePaymentEventHook(event);

      const updatedRow = await db.query.kilo_pass_scheduled_changes.findFirst({
        where: eq(kilo_pass_scheduled_changes.id, scheduledChangeId),
      });
      expect(updatedRow?.status).toBe(KiloPassScheduledChangeStatus.NotStarted);

      const syntheticInvoiceId = `kilo-pass-yearly-remaining:${scheduledChangeId}`;
      const creditTx = await db.query.credit_transactions.findFirst({
        where: eq(credit_transactions.stripe_payment_id, syntheticInvoiceId),
      });

      // `subscription_schedule.updated` should NOT issue credits. Remaining base credits are issued
      // (if applicable) by the `invoice.paid` Kilo Pass handler when a schedule change invoice is paid.
      expect(creditTx).toBeUndefined();
    });

    test('subscription_schedule.updated (status=released) soft-deletes the scheduled change row', async () => {
      const stripeSubscriptionId = `sub_kilo_pass_release_${Math.random()}`;
      const scheduleId = `sub_sched_release_${Math.random()}`;
      const scheduledChangeId = crypto.randomUUID();

      await db.insert(kilo_pass_subscriptions).values({
        kilo_user_id: testUser.id,
        stripe_subscription_id: stripeSubscriptionId,
        tier: KiloPassTier.Tier19,
        cadence: KiloPassCadence.Monthly,
        status: 'active',
        cancel_at_period_end: false,
        started_at: '2026-01-01T00:00:00.000Z',
        ended_at: null,
        current_streak_months: 0,
        next_yearly_issue_at: null,
      });

      await db.insert(kilo_pass_scheduled_changes).values({
        id: scheduledChangeId,
        kilo_user_id: testUser.id,
        stripe_subscription_id: stripeSubscriptionId,
        from_tier: KiloPassTier.Tier19,
        from_cadence: KiloPassCadence.Monthly,
        to_tier: KiloPassTier.Tier49,
        to_cadence: KiloPassCadence.Yearly,
        stripe_schedule_id: scheduleId,
        effective_at: '2026-02-01T00:00:00.000Z',
        status: KiloPassScheduledChangeStatus.NotStarted,
      });

      const event: Stripe.Event = {
        ...baseStripeEvent(),
        id: `evt_sched_released_${Math.random()}`,
        type: 'subscription_schedule.updated',
        data: {
          object: {
            id: scheduleId,
            status: KiloPassScheduledChangeStatus.Released,
          } as unknown as Stripe.SubscriptionSchedule,
          previous_attributes: {},
        },
      };

      await processStripePaymentEventHook(event);

      const updatedRow = await db.query.kilo_pass_scheduled_changes.findFirst({
        where: eq(kilo_pass_scheduled_changes.id, scheduledChangeId),
      });
      expect(updatedRow).toBeTruthy();
      expect(updatedRow?.status).toBe(KiloPassScheduledChangeStatus.Released);
      expect(updatedRow?.deleted_at).not.toBeNull();
    });

    test('subscription_schedule.updated (status=canceled) soft-deletes the scheduled change row', async () => {
      const stripeSubscriptionId = `sub_kilo_pass_cancel_${Math.random()}`;
      const scheduleId = `sub_sched_cancel_${Math.random()}`;
      const scheduledChangeId = crypto.randomUUID();

      await db.insert(kilo_pass_subscriptions).values({
        kilo_user_id: testUser.id,
        stripe_subscription_id: stripeSubscriptionId,
        tier: KiloPassTier.Tier49,
        cadence: KiloPassCadence.Monthly,
        status: 'active',
        cancel_at_period_end: false,
        started_at: '2026-01-01T00:00:00.000Z',
        ended_at: null,
        current_streak_months: 0,
        next_yearly_issue_at: null,
      });

      await db.insert(kilo_pass_scheduled_changes).values({
        id: scheduledChangeId,
        kilo_user_id: testUser.id,
        stripe_subscription_id: stripeSubscriptionId,
        from_tier: KiloPassTier.Tier49,
        from_cadence: KiloPassCadence.Monthly,
        to_tier: KiloPassTier.Tier49,
        to_cadence: KiloPassCadence.Yearly,
        stripe_schedule_id: scheduleId,
        effective_at: '2026-02-01T00:00:00.000Z',
        status: KiloPassScheduledChangeStatus.NotStarted,
      });

      const event: Stripe.Event = {
        ...baseStripeEvent(),
        id: `evt_sched_canceled_${Math.random()}`,
        type: 'subscription_schedule.updated',
        data: {
          object: {
            id: scheduleId,
            status: KiloPassScheduledChangeStatus.Canceled,
          } as unknown as Stripe.SubscriptionSchedule,
          previous_attributes: {},
        },
      };

      await processStripePaymentEventHook(event);

      const updatedRow = await db.query.kilo_pass_scheduled_changes.findFirst({
        where: eq(kilo_pass_scheduled_changes.id, scheduledChangeId),
      });
      expect(updatedRow).toBeTruthy();
      expect(updatedRow?.status).toBe(KiloPassScheduledChangeStatus.Canceled);
      expect(updatedRow?.deleted_at).not.toBeNull();
    });

    test('subscription_schedule.updated does not regress terminal status on out-of-order events', async () => {
      const stripeSubscriptionId = `sub_kilo_pass_terminal_regress_${Math.random()}`;
      const scheduleId = `sub_sched_terminal_regress_${Math.random()}`;
      const scheduledChangeId = crypto.randomUUID();

      await db.insert(kilo_pass_subscriptions).values({
        kilo_user_id: testUser.id,
        stripe_subscription_id: stripeSubscriptionId,
        tier: KiloPassTier.Tier19,
        cadence: KiloPassCadence.Monthly,
        status: 'active',
        cancel_at_period_end: false,
        started_at: '2026-01-01T00:00:00.000Z',
        ended_at: null,
        current_streak_months: 0,
        next_yearly_issue_at: null,
      });

      await db.insert(kilo_pass_scheduled_changes).values({
        id: scheduledChangeId,
        kilo_user_id: testUser.id,
        stripe_subscription_id: stripeSubscriptionId,
        from_tier: KiloPassTier.Tier19,
        from_cadence: KiloPassCadence.Monthly,
        to_tier: KiloPassTier.Tier49,
        to_cadence: KiloPassCadence.Yearly,
        stripe_schedule_id: scheduleId,
        effective_at: '2026-02-01T00:00:00.000Z',
        status: KiloPassScheduledChangeStatus.NotStarted,
      });

      const releasedEvent: Stripe.Event = {
        ...baseStripeEvent(),
        id: `evt_sched_terminal_released_${Math.random()}`,
        type: 'subscription_schedule.updated',
        data: {
          object: {
            id: scheduleId,
            status: KiloPassScheduledChangeStatus.Released,
          } as unknown as Stripe.SubscriptionSchedule,
          previous_attributes: {},
        },
      };

      await processStripePaymentEventHook(releasedEvent);

      const afterReleased = await db.query.kilo_pass_scheduled_changes.findFirst({
        where: eq(kilo_pass_scheduled_changes.id, scheduledChangeId),
      });
      expect(afterReleased).toBeTruthy();
      expect(afterReleased?.status).toBe(KiloPassScheduledChangeStatus.Released);
      expect(afterReleased?.deleted_at).not.toBeNull();

      // Out-of-order retry delivery: Stripe may send older statuses after terminal ones.
      const notStartedEvent: Stripe.Event = {
        ...baseStripeEvent(),
        id: `evt_sched_terminal_not_started_${Math.random()}`,
        type: 'subscription_schedule.updated',
        data: {
          object: {
            id: scheduleId,
            status: KiloPassScheduledChangeStatus.NotStarted,
          } as unknown as Stripe.SubscriptionSchedule,
          previous_attributes: {},
        },
      };

      await processStripePaymentEventHook(notStartedEvent);

      const afterOutOfOrder = await db.query.kilo_pass_scheduled_changes.findFirst({
        where: eq(kilo_pass_scheduled_changes.id, scheduledChangeId),
      });

      expect(afterOutOfOrder).toBeTruthy();
      expect(afterOutOfOrder?.status).toBe(KiloPassScheduledChangeStatus.Released);
      expect(afterOutOfOrder?.deleted_at).toBe(afterReleased?.deleted_at);
    });
  });
});

describe('releaseScheduledChangeForSubscription', () => {
  test('soft-deletes first and reverts the delete if Stripe release fails', async () => {
    const scheduledChangeId = crypto.randomUUID();
    const stripeSubId = `sub_release_helper_${Math.random()}`;
    const scheduleId = `sched_release_helper_${Math.random()}`;

    const user = await insertTestUser({
      google_user_email: 'kilo-pass-release-helper-revert@example.com',
    });

    await db.insert(kilo_pass_subscriptions).values({
      kilo_user_id: user.id,
      stripe_subscription_id: stripeSubId,
      tier: KiloPassTier.Tier19,
      cadence: KiloPassCadence.Monthly,
      status: 'active',
      cancel_at_period_end: false,
      current_streak_months: 1,
      started_at: new Date('2026-01-01T00:00:00.000Z').toISOString(),
      ended_at: null,
      next_yearly_issue_at: null,
    });

    await db.insert(kilo_pass_scheduled_changes).values({
      id: scheduledChangeId,
      kilo_user_id: user.id,
      stripe_subscription_id: stripeSubId,
      from_tier: KiloPassTier.Tier19,
      from_cadence: KiloPassCadence.Monthly,
      to_tier: KiloPassTier.Tier49,
      to_cadence: KiloPassCadence.Yearly,
      stripe_schedule_id: scheduleId,
      effective_at: new Date('2026-02-01T00:00:00.000Z').toISOString(),
      status: KiloPassScheduledChangeStatus.NotStarted,
      deleted_at: null,
    });

    const stripeMock = {
      subscriptionSchedules: {
        release: jest.fn(async () => {
          throw new Error('stripe release failed');
        }),
      },
    };

    await expect(
      releaseScheduledChangeForSubscription({
        dbOrTx: db,
        stripe: stripeMock,
        stripeSubscriptionId: stripeSubId,
        kiloUserIdIfMissingRow: user.id,
        reason: 'cancel_scheduled_change',
      })
    ).rejects.toThrow('stripe release failed');

    const row = await db.query.kilo_pass_scheduled_changes.findFirst({
      where: eq(kilo_pass_scheduled_changes.id, scheduledChangeId),
    });
    expect(row).toBeTruthy();
    expect(row?.deleted_at).toBeNull();
  });

  test('releasing a specific schedule id does not release the active DB schedule if they differ', async () => {
    const scheduledChangeId = crypto.randomUUID();
    const stripeSubId = `sub_release_helper_mismatch_${Math.random()}`;
    const activeScheduleId = `sched_active_${Math.random()}`;
    const orphanScheduleId = `sched_orphan_${Math.random()}`;

    const user = await insertTestUser({
      google_user_email: 'kilo-pass-release-helper-mismatch@example.com',
    });

    await db.insert(kilo_pass_subscriptions).values({
      kilo_user_id: user.id,
      stripe_subscription_id: stripeSubId,
      tier: KiloPassTier.Tier19,
      cadence: KiloPassCadence.Monthly,
      status: 'active',
      cancel_at_period_end: false,
      current_streak_months: 1,
      started_at: new Date('2026-01-01T00:00:00.000Z').toISOString(),
      ended_at: null,
      next_yearly_issue_at: null,
    });

    await db.insert(kilo_pass_scheduled_changes).values({
      id: scheduledChangeId,
      kilo_user_id: user.id,
      stripe_subscription_id: stripeSubId,
      from_tier: KiloPassTier.Tier19,
      from_cadence: KiloPassCadence.Monthly,
      to_tier: KiloPassTier.Tier49,
      to_cadence: KiloPassCadence.Yearly,
      stripe_schedule_id: activeScheduleId,
      effective_at: new Date('2026-02-01T00:00:00.000Z').toISOString(),
      status: KiloPassScheduledChangeStatus.NotStarted,
      deleted_at: null,
    });

    const release = jest.fn(async (_scheduleId: string) => ({}));
    const stripeMock = {
      subscriptionSchedules: {
        release,
      },
    };

    await releaseScheduledChangeForSubscription({
      dbOrTx: db,
      stripe: stripeMock,
      stripeEventId: 'evt_release_helper_mismatch',
      stripeSubscriptionId: stripeSubId,
      stripeScheduleIdIfMissingRow: orphanScheduleId,
      kiloUserIdIfMissingRow: user.id,
      reason: 'schedule_change_creation_failed',
    });

    expect(release).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledWith(orphanScheduleId);
    expect(release).not.toHaveBeenCalledWith(activeScheduleId);

    const row = await db.query.kilo_pass_scheduled_changes.findFirst({
      where: eq(kilo_pass_scheduled_changes.id, scheduledChangeId),
    });
    expect(row).toBeTruthy();
    expect(row?.deleted_at).toBeNull();
    expect(row?.status).toBe(KiloPassScheduledChangeStatus.NotStarted);

    const auditLog = await db.query.kilo_pass_audit_log.findFirst({
      where: eq(kilo_pass_audit_log.stripe_event_id, 'evt_release_helper_mismatch'),
    });
    expect(auditLog?.payload_json).toEqual(
      expect.objectContaining({
        note: 'released_schedule_id_mismatch',
        scheduleId: orphanScheduleId,
        activeScheduleId,
      })
    );
  });
});

describe('isCardFingerprintEligibleForFreeCredits', () => {
  let testUser: User;
  let anotherUser: User;

  beforeEach(async () => {
    testUser = await insertTestUser();
    anotherUser = await insertTestUser();
  });

  test('should return false for null fingerprint', async () => {
    const result = await isCardFingerprintEligibleForFreeCredits(null, testUser.id);
    expect(result).toBe(false);
  });

  test('should return false for undefined fingerprint', async () => {
    const result = await isCardFingerprintEligibleForFreeCredits(undefined, testUser.id);
    expect(result).toBe(false);
  });

  test('should return false for empty string fingerprint', async () => {
    const result = await isCardFingerprintEligibleForFreeCredits('', testUser.id);
    expect(result).toBe(false);
  });

  test('should return true for valid fingerprint with no existing payment methods', async () => {
    const uniqueFingerprint = `test_fingerprint_${Date.now()}_${Math.random()}`;
    const result = await isCardFingerprintEligibleForFreeCredits(uniqueFingerprint, testUser.id);
    expect(result).toBe(true);
  });

  test('should return true when fingerprint exists only for the same user', async () => {
    const fingerprint = `test_fingerprint_same_user_${Date.now()}`;

    // Create payment method for the same user
    const paymentMethod = {
      ...createTestPaymentMethod(testUser.id),
      stripe_fingerprint: fingerprint,
    };
    await db.insert(payment_methods).values(paymentMethod);

    const result = await isCardFingerprintEligibleForFreeCredits(fingerprint, testUser.id);
    expect(result).toBe(true);
  });

  test('should return false when fingerprint exists for a different user', async () => {
    const fingerprint = `test_fingerprint_different_user_${Date.now()}`;

    // Create payment method for a different user
    const paymentMethod = {
      ...createTestPaymentMethod(anotherUser.id),
      stripe_fingerprint: fingerprint,
    };
    await db.insert(payment_methods).values(paymentMethod);

    const result = await isCardFingerprintEligibleForFreeCredits(fingerprint, testUser.id);
    expect(result).toBe(false);
  });

  test('should return false when fingerprint exists for different user even if soft-deleted', async () => {
    const fingerprint = `test_fingerprint_soft_deleted_${Date.now()}`;

    // Create soft-deleted payment method for a different user
    const paymentMethod = {
      ...createTestPaymentMethod(anotherUser.id),
      stripe_fingerprint: fingerprint,
      deleted_at: new Date().toISOString(),
    };
    await db.insert(payment_methods).values(paymentMethod);

    const result = await isCardFingerprintEligibleForFreeCredits(fingerprint, testUser.id);
    expect(result).toBe(false);
  });
});

// === handleSuccessfulChargeWithPayment tests ===

describe('handleSuccessfulChargeWithPayment (org/user routing & side-effects)', () => {
  const makeCharge = (params: { id: string; amount: number; customer: string }) =>
    ({
      id: params.id,
      amount: params.amount,
      customer: params.customer,
    }) as unknown as Stripe.Charge;

  const makePaymentIntent = (params: {
    id: string;
    metadata: StripeTopupMetadata;
    payment_method?: Stripe.PaymentMethod | null;
  }) =>
    ({
      id: params.id,
      object: 'payment_intent',
      metadata: params.metadata ?? {},
      status: 'succeeded',
      payment_method: params.payment_method ?? null,
    }) as unknown as Stripe.PaymentIntent;

  test('both organizationId and kiloUserId: processes organization top-up; uses kiloUserId', async () => {
    const user = await insertTestUser();
    const org = await createOrganization('Org-Both', user.id);
    const amountInCents = 2300;
    const piId = `pi_both_${Math.random()}`;
    const chId = `ch_both_${Math.random()}`;

    const charge = makeCharge({ id: chId, amount: amountInCents, customer: 'cus_irrelevant' });
    const paymentIntent = makePaymentIntent({
      id: piId,
      metadata: { organizationId: org.id, kiloUserId: user.id },
    });

    await handleSuccessfulChargeWithPayment(charge, paymentIntent);

    const updatedOrg = await db.query.organizations.findFirst({
      where: eq(organizations.id, org.id),
    });
    const expectedIncrease = amountInCents * 10_000;
    expect(updatedOrg?.microdollars_balance).toBe(org.microdollars_balance + expectedIncrease);

    const creditTx = await db.query.credit_transactions.findFirst({
      where: eq(credit_transactions.stripe_payment_id, piId),
    });

    expect(creditTx).toBeTruthy();
    expect(creditTx?.kilo_user_id).toBe(user.id); // prefers kiloUserId over org-id
    expect(creditTx?.organization_id).toBe(org.id);
    expect(creditTx?.amount_microdollars).toBe(expectedIncrease);
    expect(creditTx?.is_free).toBe(false);
    expect(creditTx?.description).toBe('Organization top-up via stripe');
  });

  test('kiloUserId only (no organizationId) and NOT a stripe-checkout-topup: ignored (no DB side-effects)', async () => {
    const user = await insertTestUser();
    const amountInCents = 4200;
    const piId = `pi_unknown_${Math.random()}`;
    const chId = `ch_unknown_${Math.random()}`;

    const charge = makeCharge({
      id: chId,
      amount: amountInCents,
      customer: user.stripe_customer_id,
    });
    const paymentIntent = makePaymentIntent({
      id: piId,
      // Unknown charge type - no stripe-checkout-topup
      metadata: { kiloUserId: user.id, type: 'something-else' },
      payment_method: null,
    });

    await handleSuccessfulChargeWithPayment(charge, paymentIntent);

    // Should NOT create a credit transaction
    const creditTx = await db.query.credit_transactions.findFirst({
      where: eq(credit_transactions.stripe_payment_id, chId),
    });

    expect(creditTx).toBeUndefined();
  });
  test('kiloUserId only (no organizationId) with stripe-checkout-topup: processes user top-up', async () => {
    const user = await insertTestUser();
    const amountInCents = 6100; // $61.00
    const chargeId = `ch_user_topup_${Math.random()}`;
    const paymentIntentId = `pi_user_topup_${Math.random()}`;

    const charge = makeCharge({
      id: chargeId,
      amount: amountInCents,
      customer: user.stripe_customer_id, // required to resolve user
    });

    // Mark as stripe-checkout-driven top-up, no card details to avoid free-credits flow side effects
    const paymentIntent = makePaymentIntent({
      id: paymentIntentId,
      metadata: { kiloUserId: user.id, type: 'stripe-checkout-topup' },
      payment_method: null,
    });

    await handleSuccessfulChargeWithPayment(charge, paymentIntent);

    // For user top-ups, handleSuccessfulChargeWithPayment passes config.stripe_payment_id = charge.id
    const creditTx = await db.query.credit_transactions.findFirst({
      where: eq(credit_transactions.stripe_payment_id, chargeId),
    });

    expect(creditTx).toBeTruthy();
    expect(creditTx?.stripe_payment_id).toBe(chargeId);
    expect(creditTx?.kilo_user_id).toBe(user.id);
    expect(creditTx?.organization_id).toBeNull();
    expect(creditTx?.amount_microdollars).toBe(amountInCents * 10_000);
    expect(creditTx?.is_free).toBe(false);
    expect(creditTx?.description).toBe('Top-up via stripe');

    // Verify user aggregate balance fields updated
    const updatedUser = await db.query.kilocode_users.findFirst({
      where: eq(kilocode_users.id, user.id),
    });
    expect(updatedUser?.total_microdollars_acquired).toBe(
      amountInCents * 10_000 + FIRST_TOPUP_BONUS_AMOUNT() * 1_000_000
    );
  });

  test('neither organizationId nor kiloUserId (no user found): ignored (no DB side-effects)', async () => {
    const amountInCents = 8000;
    const piId = `pi_neither_${Math.random()}`;
    const chId = `ch_neither_${Math.random()}`;

    const charge = makeCharge({ id: chId, amount: amountInCents, customer: 'cus_nonexistent' });
    const paymentIntent = makePaymentIntent({
      id: piId,
      metadata: {}, // no orgId, no kiloUserId, no topup type
      payment_method: null,
    });

    await handleSuccessfulChargeWithPayment(charge, paymentIntent);

    const txByPi = await db.query.credit_transactions.findFirst({
      where: eq(credit_transactions.stripe_payment_id, piId),
    });
    const txByCh = await db.query.credit_transactions.findFirst({
      where: eq(credit_transactions.stripe_payment_id, chId),
    });

    expect(txByPi).toBeUndefined();
    expect(txByCh).toBeUndefined();
  });

  test('auto-topup-setup: persists auto_top_up_configs via partial-unique-index upsert (requires targetWhere)', async () => {
    await cleanupDbForTest();

    const user = await insertTestUser();

    const charge = makeCharge({
      id: `ch_auto_topup_setup_${Math.random()}`,
      amount: 1500,
      customer: user.stripe_customer_id,
    });

    const firstPaymentIntent: Stripe.PaymentIntent = {
      id: `pi_auto_topup_setup_${Math.random()}`,
      object: 'payment_intent',
      status: 'succeeded',
      payment_method: `pm_first_${Math.random()}`,
      metadata: {
        type: 'auto-topup-setup',
        kiloUserId: user.id,
        amountCents: '2000',
      },
    } as unknown as Stripe.PaymentIntent;

    await handleSuccessfulChargeWithPayment(charge, firstPaymentIntent);

    const configAfterFirst = await db.query.auto_top_up_configs.findFirst({
      where: eq(auto_top_up_configs.owned_by_user_id, user.id),
    });

    expect(configAfterFirst).toBeTruthy();
    expect(configAfterFirst?.owned_by_user_id).toBe(user.id);
    expect(configAfterFirst?.stripe_payment_method_id).toBe(firstPaymentIntent.payment_method);
    expect(configAfterFirst?.amount_cents).toBe(2000);
    expect(configAfterFirst?.disabled_reason).toBeNull();

    const userAfterFirst = await db.query.kilocode_users.findFirst({
      where: eq(kilocode_users.id, user.id),
    });
    expect(userAfterFirst?.auto_top_up_enabled).toBe(true);

    const secondPaymentIntent: Stripe.PaymentIntent = {
      id: `pi_auto_topup_setup_${Math.random()}`,
      object: 'payment_intent',
      status: 'succeeded',
      payment_method: `pm_second_${Math.random()}`,
      metadata: {
        type: 'auto-topup-setup',
        kiloUserId: user.id,
        amountCents: '5000',
      },
    } as unknown as Stripe.PaymentIntent;

    await handleSuccessfulChargeWithPayment(charge, secondPaymentIntent);

    const configsForUser = await db
      .select({ count: count() })
      .from(auto_top_up_configs)
      .where(eq(auto_top_up_configs.owned_by_user_id, user.id));
    expect(configsForUser[0]?.count).toBe(1);

    const configAfterSecond = await db.query.auto_top_up_configs.findFirst({
      where: eq(auto_top_up_configs.owned_by_user_id, user.id),
    });
    expect(configAfterSecond?.stripe_payment_method_id).toBe(secondPaymentIntent.payment_method);
    expect(configAfterSecond?.amount_cents).toBe(5000);
    expect(configAfterSecond?.disabled_reason).toBeNull();
  });

  test('org-auto-topup-setup: persists auto_top_up_configs via partial-unique-index upsert (requires targetWhere)', async () => {
    await cleanupDbForTest();

    const user = await insertTestUser();
    const org = await createOrganization('Org Auto Topup Setup', user.id);

    // This flow stores an org payment method by fetching it from Stripe.
    // Mock it to keep the test hermetic.
    const { client } = await import('@/lib/stripe-client');
    const stripePaymentMethod = sampleStripePaymentMethod();

    const stripePaymentMethodResponse = {
      ...stripePaymentMethod,
      lastResponse: {
        headers: {},
        requestId: 'req_test_stripe_payment_method',
        statusCode: 200,
      },
    } satisfies Stripe.Response<Stripe.PaymentMethod>;

    const retrieveSpy = jest
      .spyOn(client.paymentMethods, 'retrieve')
      .mockResolvedValue(stripePaymentMethodResponse);

    const charge = makeCharge({
      id: `ch_org_auto_topup_setup_${Math.random()}`,
      amount: 1500,
      customer: user.stripe_customer_id,
    });

    const firstPaymentIntent: Stripe.PaymentIntent = {
      id: `pi_org_auto_topup_setup_${Math.random()}`,
      object: 'payment_intent',
      status: 'succeeded',
      payment_method: `pm_org_first_${Math.random()}`,
      metadata: {
        type: 'org-auto-topup-setup',
        kiloUserId: user.id,
        organizationId: org.id,
        amountCents: '2000',
      },
    } as unknown as Stripe.PaymentIntent;

    try {
      await handleSuccessfulChargeWithPayment(charge, firstPaymentIntent);

      const configAfterFirst = await db.query.auto_top_up_configs.findFirst({
        where: eq(auto_top_up_configs.owned_by_organization_id, org.id),
      });

      expect(configAfterFirst).toBeTruthy();
      expect(configAfterFirst?.owned_by_organization_id).toBe(org.id);
      expect(configAfterFirst?.stripe_payment_method_id).toBe(firstPaymentIntent.payment_method);
      expect(configAfterFirst?.amount_cents).toBe(2000);
      expect(configAfterFirst?.disabled_reason).toBeNull();

      const orgAfterFirst = await db.query.organizations.findFirst({
        where: eq(organizations.id, org.id),
      });
      expect(orgAfterFirst?.auto_top_up_enabled).toBe(true);

      const secondPaymentIntent: Stripe.PaymentIntent = {
        id: `pi_org_auto_topup_setup_${Math.random()}`,
        object: 'payment_intent',
        status: 'succeeded',
        payment_method: `pm_org_second_${Math.random()}`,
        metadata: {
          type: 'org-auto-topup-setup',
          kiloUserId: user.id,
          organizationId: org.id,
          amountCents: '5000',
        },
      } as unknown as Stripe.PaymentIntent;

      await handleSuccessfulChargeWithPayment(charge, secondPaymentIntent);

      const configsForOrg = await db
        .select({ count: count() })
        .from(auto_top_up_configs)
        .where(eq(auto_top_up_configs.owned_by_organization_id, org.id));
      expect(configsForOrg[0]?.count).toBe(1);

      const configAfterSecond = await db.query.auto_top_up_configs.findFirst({
        where: eq(auto_top_up_configs.owned_by_organization_id, org.id),
      });
      expect(configAfterSecond?.stripe_payment_method_id).toBe(secondPaymentIntent.payment_method);
      expect(configAfterSecond?.amount_cents).toBe(5000);
      expect(configAfterSecond?.disabled_reason).toBeNull();
    } finally {
      retrieveSpy.mockRestore();
    }
  });
});
