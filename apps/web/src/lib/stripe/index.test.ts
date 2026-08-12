process.env.STRIPE_KILOCLAW_2026_03_19_STANDARD_INTRO_PRICE_ID ||= 'price_legacy_standard_intro';
process.env.STRIPE_KILOCLAW_2026_03_19_STANDARD_PRICE_ID ||= 'price_legacy_standard';
process.env.STRIPE_KILOCLAW_2026_03_19_COMMIT_PRICE_ID ||= 'price_legacy_commit';
process.env.STRIPE_KILOCLAW_2026_05_10_STANDARD_PRICE_ID ||= 'price_current_standard';
process.env.STRIPE_KILOCLAW_2026_05_10_COMMIT_PRICE_ID ||= 'price_current_commit';
process.env.STRIPE_KILO_PASS_TIER_19_MONTHLY_PRICE_ID ||= 'price_test_kilo_pass_tier_19_monthly';
process.env.STRIPE_KILO_PASS_TIER_19_YEARLY_PRICE_ID ||= 'price_test_kilo_pass_tier_19_yearly';
process.env.STRIPE_KILO_PASS_TIER_49_MONTHLY_PRICE_ID ||= 'price_test_kilo_pass_tier_49_monthly';
process.env.STRIPE_KILO_PASS_TIER_49_YEARLY_PRICE_ID ||= 'price_test_kilo_pass_tier_49_yearly';
process.env.STRIPE_KILO_PASS_TIER_199_MONTHLY_PRICE_ID ||= 'price_test_kilo_pass_tier_199_monthly';
process.env.STRIPE_KILO_PASS_TIER_199_YEARLY_PRICE_ID ||= 'price_test_kilo_pass_tier_199_yearly';

const CURRENT_KILOCLAW_STANDARD_PRICE_ID =
  process.env.STRIPE_KILOCLAW_2026_05_10_STANDARD_PRICE_ID ?? 'price_current_standard';
const CURRENT_KILO_PASS_TIER_19_MONTHLY_PRICE_ID =
  process.env.STRIPE_KILO_PASS_TIER_19_MONTHLY_PRICE_ID ?? 'price_test_kilo_pass_tier_19_monthly';

import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import type * as creditsModule from '@/lib/credits';
import type * as organizationBillingModule from '@/lib/organizations/organization-billing';

// Allow spying on processTopUp / processTopupForOrganization inside stripe.ts.
// The mock delegates to the real implementation by default so existing tests are unaffected.
// We use global `jest` (not the @jest/globals import) because SWC only hoists bare
// `jest.mock(...)` calls — it does NOT hoist `importedJest.mock(...)`.
jest.mock('@/lib/credits', () => {
  const actual = jest.requireActual<typeof creditsModule>('@/lib/credits');
  return {
    __esModule: true,
    ...actual,
    processTopUp: jest.fn((...args: Parameters<typeof actual.processTopUp>) =>
      actual.processTopUp(...args)
    ),
  };
});
jest.mock('@/lib/organizations/organization-billing', () => {
  const actual = jest.requireActual<typeof organizationBillingModule>(
    '@/lib/organizations/organization-billing'
  );
  return {
    __esModule: true,
    ...actual,
    processTopupForOrganization: jest.fn(
      (...args: Parameters<typeof actual.processTopupForOrganization>) =>
        actual.processTopupForOrganization(...args)
    ),
  };
});
jest.mock(
  'tldts',
  () => ({
    getDomain: jest.fn((host: string) => host),
  }),
  { virtual: true }
);
jest.mock('@/lib/ai-gateway/abuse-service', () => ({
  reportEvents: jest.fn(async () => undefined),
}));
import {
  type StripeTopupMetadata,
  ensurePaymentMethodStored,
  processStripePaymentEventHook,
  handleSuccessfulChargeWithPayment,
  handleUpdateSeatCount,
  isCardFingerprintEligibleForFreeCredits,
  KNOWN_SEAT_PRICE_IDS,
} from '@/lib/stripe';
import { client } from '@/lib/stripe-client';
import * as kiloPassOrgStripe from '@/lib/kilo-pass-org/stripe-adapter';
import {
  type ServiceFeeAssessmentRecord,
  type ServiceFeeAssessmentStore,
} from '@/lib/service-fees/assessments';
import { SEAT_PRODUCT_IDS } from '@/lib/organizations/stripe-seat-line-items';
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
  pending_impact_sale_reversals,
  stripe_dispute_cases,
  stripe_early_fraud_warning_actions,
  stripe_early_fraud_warning_cases,
  user_affiliate_attributions,
  user_affiliate_events,
  impact_referral_conversions,
  impact_referral_reward_decisions,
  impact_referral_rewards,
  stripe_service_fee_assessments,
} from '@kilocode/db/schema';
import { db, auto_deleted_at } from '@/lib/drizzle';
import { insertTestUser } from '@/tests/helpers/user.helper';
import { softDeleteUser } from '@/lib/user';
import { createTestPaymentMethod } from '@/tests/helpers/payment-method.helper';
import { eq, and, count } from 'drizzle-orm';
import type Stripe from 'stripe';
import { createOrganization } from '@/lib/organizations/organizations';
import { releaseScheduledChangeForSubscription } from '@/lib/kilo-pass/scheduled-change-release';
import {
  KiloPassCadence,
  KiloPassScheduledChangeStatus,
  KiloPassTier,
} from '@/lib/kilo-pass/enums';
import {
  ImpactReferralBeneficiaryRole,
  ImpactReferralDecisionOutcome,
  ImpactReferralPaymentProvider,
  ImpactReferralProduct,
  ImpactReferralRewardKind,
  ImpactReferralRewardStatus,
  ImpactReferralWinningTouchType,
  StripeDisputeCaseStatus,
  StripeDisputeOwnerClassification,
} from '@kilocode/db/schema-types';
import type * as kiloclawStripeHandlersModule from '@/lib/kiloclaw/stripe-handlers';
import type * as kiloPassStripeHandlersModule from '@/lib/kilo-pass/stripe-handlers';
import { cleanupDbForTest } from '@/lib/drizzle';
import { processTopUp } from '@/lib/credits';
import { processTopupForOrganization } from '@/lib/organizations/organization-billing';
import { reportEvents } from '@/lib/ai-gateway/abuse-service';
import { SERVICE_FEE_ACTIVATION_UNIX_SECONDS } from '@/lib/service-fees/constants';

const reportEventsMock = jest.mocked(reportEvents);

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

async function mockChargeRetrieveForKiloClaw(priceId: string) {
  const { client } = await import('@/lib/stripe-client');
  const invoice = {
    object: 'invoice',
    lines: {
      data: [{ pricing: { price_details: { price: priceId } } }],
    },
  } as unknown as Stripe.Invoice;
  return jest.spyOn(client.charges, 'retrieve').mockResolvedValue({
    invoice,
    lastResponse: { headers: {}, requestId: 'req_test', statusCode: 200 },
  } as unknown as Stripe.Response<Stripe.Charge>);
}

async function mockChargeRetrieveForKiloPass(invoiceId: string, userId: string) {
  const { client } = await import('@/lib/stripe-client');
  const invoice = {
    id: invoiceId,
    object: 'invoice',
    parent: {
      subscription_details: {
        metadata: {
          type: 'kilo-pass',
          kiloUserId: userId,
          tier: KiloPassTier.Tier19,
          cadence: KiloPassCadence.Monthly,
        },
      },
    },
    lines: { data: [] },
  } as unknown as Stripe.Invoice;
  return jest.spyOn(client.charges, 'retrieve').mockResolvedValue({
    invoice,
    lastResponse: { headers: {}, requestId: 'req_test', statusCode: 200 },
  } as unknown as Stripe.Response<Stripe.Charge>);
}

async function seedKiloPassReferralReward(params: {
  userId: string;
  invoiceId: string;
  status: ImpactReferralRewardStatus;
}) {
  const [conversion] = await db
    .insert(impact_referral_conversions)
    .values({
      product: ImpactReferralProduct.KiloPass,
      referee_user_id: params.userId,
      winning_touch_type: ImpactReferralWinningTouchType.Referral,
      payment_provider: ImpactReferralPaymentProvider.Stripe,
      source_payment_id: params.invoiceId,
      qualified: true,
      converted_at: '2026-01-03T00:00:00.000Z',
    })
    .returning({ id: impact_referral_conversions.id });
  if (!conversion) throw new Error('Failed to insert Kilo Pass referral conversion');

  const [decision] = await db
    .insert(impact_referral_reward_decisions)
    .values({
      product: ImpactReferralProduct.KiloPass,
      conversion_id: conversion.id,
      beneficiary_user_id: params.userId,
      beneficiary_role: ImpactReferralBeneficiaryRole.Referee,
      outcome: ImpactReferralDecisionOutcome.Granted,
      reward_kind: ImpactReferralRewardKind.KiloPassBonus,
      months_granted: 0,
      reward_percent: 0.5,
      source_tier: KiloPassTier.Tier19,
      reward_amount_usd: 9.5,
    })
    .returning({ id: impact_referral_reward_decisions.id });
  if (!decision) throw new Error('Failed to insert Kilo Pass referral decision');

  const [reward] = await db
    .insert(impact_referral_rewards)
    .values({
      product: ImpactReferralProduct.KiloPass,
      conversion_id: conversion.id,
      decision_id: decision.id,
      beneficiary_user_id: params.userId,
      beneficiary_role: ImpactReferralBeneficiaryRole.Referee,
      reward_kind: ImpactReferralRewardKind.KiloPassBonus,
      months_granted: 0,
      reward_percent: 0.5,
      source_tier: KiloPassTier.Tier19,
      reward_amount_usd: 9.5,
      status: params.status,
      earned_at: '2026-01-03T00:00:00.000Z',
      applied_at:
        params.status === ImpactReferralRewardStatus.Applied ? '2026-02-01T00:00:00.000Z' : null,
      expires_at: '2027-01-03T00:00:00.000Z',
    })
    .returning({ id: impact_referral_rewards.id });
  if (!reward) throw new Error('Failed to insert Kilo Pass referral reward');

  return reward.id;
}

const sampleStripeDispute = (
  overrides: Partial<Stripe.Dispute> & Pick<Stripe.Dispute, 'id'>
): Stripe.Dispute => {
  const { id, ...rest } = overrides;

  return {
    id,
    object: 'dispute',
    amount: 2900,
    balance_transactions: [],
    charge: 'ch_test',
    created: 1712743200,
    currency: 'usd',
    enhanced_eligibility_types: [],
    evidence: {
      access_activity_log: null,
      billing_address: null,
      cancellation_policy: null,
      cancellation_policy_disclosure: null,
      cancellation_rebuttal: null,
      customer_communication: null,
      customer_email_address: null,
      customer_name: null,
      customer_purchase_ip: null,
      customer_signature: null,
      duplicate_charge_documentation: null,
      duplicate_charge_explanation: null,
      duplicate_charge_id: null,
      enhanced_evidence: {},
      product_description: null,
      receipt: null,
      refund_policy: null,
      refund_policy_disclosure: null,
      refund_refusal_explanation: null,
      service_date: null,
      service_documentation: null,
      shipping_address: null,
      shipping_carrier: null,
      shipping_date: null,
      shipping_documentation: null,
      shipping_tracking_number: null,
      uncategorized_file: null,
      uncategorized_text: null,
    },
    evidence_details: {
      due_by: null,
      enhanced_eligibility: {},
      has_evidence: false,
      past_due: false,
      submission_count: 0,
    },
    is_charge_refundable: false,
    livemode: false,
    metadata: {},
    payment_intent: null,
    reason: 'fraudulent',
    status: 'warning_needs_response',
    ...rest,
  };
};

const sampleStripeCharge = (
  overrides: Partial<Stripe.Charge> & Pick<Stripe.Charge, 'id'>
): Stripe.Charge => {
  const { id, ...rest } = overrides;

  return {
    id,
    object: 'charge',
    amount: 1000,
    amount_captured: 0,
    amount_refunded: 0,
    application: null,
    application_fee: null,
    application_fee_amount: null,
    balance_transaction: null,
    billing_details: {
      address: null,
      email: null,
      name: null,
      phone: null,
      tax_id: null,
    },
    calculated_statement_descriptor: null,
    captured: false,
    created: 1712743200,
    currency: 'usd',
    customer: null,
    description: null,
    disputed: false,
    failure_balance_transaction: null,
    failure_code: null,
    failure_message: null,
    fraud_details: {},
    livemode: false,
    metadata: {},
    on_behalf_of: null,
    outcome: null,
    paid: false,
    payment_intent: null,
    payment_method: null,
    payment_method_details: null,
    receipt_email: null,
    receipt_number: null,
    receipt_url: null,
    refunded: false,
    refunds: { object: 'list', data: [], has_more: false, url: '' },
    review: null,
    shipping: null,
    source: null,
    source_transfer: null,
    statement_descriptor: null,
    statement_descriptor_suffix: null,
    status: 'failed',
    transfer_data: null,
    transfer_group: null,
    ...rest,
  } as Stripe.Charge;
};

const sampleStripeChargeResponse = (
  charge: Stripe.Charge,
  overrides: Record<string, unknown> = {}
): Stripe.Response<Stripe.Charge> =>
  ({
    ...charge,
    ...overrides,
    lastResponse: { headers: {}, requestId: 'req_test', statusCode: 200 },
  }) as Stripe.Response<Stripe.Charge>;

function sampleEarlyFraudWarningEvent(params: {
  eventId: string;
  warningId: string;
  charge: string | null;
  paymentIntent?: string | null;
}): Stripe.Event {
  return {
    ...baseStripeEvent(),
    id: params.eventId,
    data: {
      object: {
        id: params.warningId,
        object: 'radar.early_fraud_warning',
        actionable: true,
        charge: params.charge,
        created: 1234567890,
        fraud_type: 'stolen_card',
        livemode: false,
        payment_intent: params.paymentIntent ?? null,
      },
      previous_attributes: {},
    },
    type: 'radar.early_fraud_warning.created',
  } as unknown as Stripe.Event;
}

async function waitForReportEventsCall() {
  for (let attempt = 0; attempt < 10; attempt++) {
    if (reportEventsMock.mock.calls.length > 0) return;
    await new Promise(resolve => setImmediate(resolve));
  }
  throw new Error('Timed out waiting for reportEvents to be called');
}

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
    reportEventsMock.mockClear();
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

  test('payment_intent.succeeded reports customer and amount to abuse service', async () => {
    const paymentIntent = sampleStripePaymentIntent();
    paymentIntent.customer = testUser.stripe_customer_id;
    paymentIntent.amount = 1500;
    paymentIntent.amount_received = 1400;

    const event: Stripe.Event = {
      ...baseStripeEvent(),
      id: 'evt_payment_intent_succeeded',
      data: {
        object: paymentIntent,
        previous_attributes: {},
      },
      type: 'payment_intent.succeeded',
    };

    await processStripePaymentEventHook(event);

    const paymentMethodExists = await db.query.payment_methods.findFirst({
      where: eq(payment_methods.user_id, testUser.id),
    });

    expect(paymentMethodExists).toBeUndefined();
    expect(reportEventsMock).toHaveBeenCalledWith({
      events: [
        {
          type: 'stripe.payment_intent.succeeded',
          occurred_at: 1234567890000,
          data: {
            id: 'evt_payment_intent_succeeded',
            type: 'payment_intent.succeeded',
            payment_intent: 'pi_test_123',
            customer: testUser.stripe_customer_id,
            amount: 1400,
          },
        },
      ],
    });
  });

  test('charge.failed reports customer and decline code to abuse service', async () => {
    const event: Stripe.Event = {
      ...baseStripeEvent(),
      id: 'evt_charge_failed',
      data: {
        object: sampleStripeCharge({
          id: 'ch_failed_123',
          customer: testUser.stripe_customer_id,
          outcome: {
            advice_code: null,
            network_advice_code: null,
            network_decline_code: null,
            network_status: 'declined_by_network',
            reason: 'insufficient_funds',
            risk_level: 'normal',
            risk_score: 12,
            seller_message: 'The bank returned the decline code `insufficient_funds`.',
            type: 'issuer_declined',
          },
        }),
        previous_attributes: {},
      },
      type: 'charge.failed',
    };

    await processStripePaymentEventHook(event);

    expect(reportEventsMock).toHaveBeenCalledWith({
      events: [
        {
          type: 'stripe.charge.failed',
          occurred_at: 1234567890000,
          data: {
            id: 'evt_charge_failed',
            type: 'charge.failed',
            charge: 'ch_failed_123',
            customer: testUser.stripe_customer_id,
            decline_code: 'insufficient_funds',
          },
        },
      ],
    });
  });

  test('radar.early_fraud_warning.created persists a personal observation and preserves abuse telemetry', async () => {
    await cleanupDbForTest();
    testUser = await insertTestUser();
    const { client } = await import('@/lib/stripe-client');
    const retrieveSpy = jest.spyOn(client.charges, 'retrieve').mockResolvedValue(
      sampleStripeChargeResponse(
        sampleStripeCharge({
          id: 'ch_radar_123',
          amount: 1900,
          currency: 'usd',
          customer: testUser.stripe_customer_id,
          payment_intent: 'pi_radar_123',
        })
      )
    );

    await processStripePaymentEventHook(
      sampleEarlyFraudWarningEvent({
        eventId: 'evt_radar_warning',
        warningId: 'issfr_123',
        charge: 'ch_radar_123',
      })
    );
    await waitForReportEventsCall();

    const [fraudCase] = await db.select().from(stripe_early_fraud_warning_cases);
    const actions = await db.select().from(stripe_early_fraud_warning_actions);
    expect(fraudCase).toEqual(
      expect.objectContaining({
        stripe_early_fraud_warning_id: 'issfr_123',
        stripe_event_id: 'evt_radar_warning',
        stripe_charge_id: 'ch_radar_123',
        stripe_payment_intent_id: 'pi_radar_123',
        stripe_customer_id: testUser.stripe_customer_id,
        amount_minor_units: 1900,
        currency: 'usd',
        owner_classification: 'personal',
        kilo_user_id: testUser.id,
        organization_id: null,
        status: 'review_required',
        reason: 'Observation only: canonical personal owner matched; manual review required',
      })
    );
    expect(fraudCase.review_required_at).not.toBeNull();
    expect(actions).toHaveLength(0);
    expect(retrieveSpy).toHaveBeenCalledTimes(1);
    expect(retrieveSpy).toHaveBeenCalledWith('ch_radar_123');
    expect(reportEventsMock).toHaveBeenCalledWith({
      events: [
        {
          type: 'stripe.radar.early_fraud_warning.created',
          occurred_at: 1234567890000,
          data: {
            id: 'evt_radar_warning',
            type: 'radar.early_fraud_warning.created',
            charge: 'ch_radar_123',
            customer: testUser.stripe_customer_id,
            payment_intent: 'pi_radar_123',
            early_fraud_warning: 'issfr_123',
          },
        },
      ],
    });

    retrieveSpy.mockRestore();
  });

  test('radar.early_fraud_warning.created does not link a new case to a soft-deleted user', async () => {
    await cleanupDbForTest();
    testUser = await insertTestUser();
    await softDeleteUser(testUser.id);
    const { client } = await import('@/lib/stripe-client');
    const retrieveSpy = jest.spyOn(client.charges, 'retrieve').mockResolvedValue(
      sampleStripeChargeResponse(
        sampleStripeCharge({
          id: 'ch_deleted_customer',
          customer: testUser.stripe_customer_id,
        })
      )
    );

    await processStripePaymentEventHook(
      sampleEarlyFraudWarningEvent({
        eventId: 'evt_deleted_customer',
        warningId: 'issfr_deleted_customer',
        charge: 'ch_deleted_customer',
      })
    );

    const [fraudCase] = await db.select().from(stripe_early_fraud_warning_cases);
    expect(fraudCase).toEqual(
      expect.objectContaining({
        stripe_customer_id: testUser.stripe_customer_id,
        owner_classification: 'unmatched',
        kilo_user_id: null,
        status: 'review_required',
        reason: 'No canonical customer owner matched; manual review required',
      })
    );
    expect(await db.select().from(stripe_early_fraud_warning_actions)).toHaveLength(0);

    retrieveSpy.mockRestore();
  });

  test('radar.early_fraud_warning.created does not link a case during concurrent soft deletion', async () => {
    await cleanupDbForTest();
    testUser = await insertTestUser();
    const { client } = await import('@/lib/stripe-client');
    const retrieveSpy = jest.spyOn(client.charges, 'retrieve').mockResolvedValue(
      sampleStripeChargeResponse(
        sampleStripeCharge({
          id: 'ch_deleting_customer',
          customer: testUser.stripe_customer_id,
        })
      )
    );
    let observationPromise: Promise<void> | null = null;

    await db.transaction(async tx => {
      await tx
        .update(kilocode_users)
        .set({ blocked_reason: 'soft-deleted at 2026-05-28T12:00:00.000Z' })
        .where(eq(kilocode_users.id, testUser.id));
      observationPromise = processStripePaymentEventHook(
        sampleEarlyFraudWarningEvent({
          eventId: 'evt_deleting_customer',
          warningId: 'issfr_deleting_customer',
          charge: 'ch_deleting_customer',
        })
      );
      await new Promise(resolve => setImmediate(resolve));
    });

    if (!observationPromise) {
      throw new Error('Observation did not start during deletion transaction');
    }
    await observationPromise;

    const [fraudCase] = await db.select().from(stripe_early_fraud_warning_cases);
    expect(fraudCase).toEqual(
      expect.objectContaining({
        stripe_customer_id: testUser.stripe_customer_id,
        owner_classification: 'unmatched',
        kilo_user_id: null,
        status: 'review_required',
      })
    );
    expect(await db.select().from(stripe_early_fraud_warning_actions)).toHaveLength(0);

    retrieveSpy.mockRestore();
  });

  test('radar.early_fraud_warning.created deduplicates repeated delivery without creating actions', async () => {
    await cleanupDbForTest();
    testUser = await insertTestUser();
    const { client } = await import('@/lib/stripe-client');
    const retrieveSpy = jest
      .spyOn(client.charges, 'retrieve')
      .mockResolvedValue(
        sampleStripeChargeResponse(
          sampleStripeCharge({ id: 'ch_duplicate', customer: testUser.stripe_customer_id })
        )
      );

    await processStripePaymentEventHook(
      sampleEarlyFraudWarningEvent({
        eventId: 'evt_duplicate_first',
        warningId: 'issfr_duplicate',
        charge: 'ch_duplicate',
      })
    );
    await processStripePaymentEventHook(
      sampleEarlyFraudWarningEvent({
        eventId: 'evt_duplicate_second',
        warningId: 'issfr_duplicate',
        charge: 'ch_duplicate',
      })
    );

    const fraudCases = await db.select().from(stripe_early_fraud_warning_cases);
    const actions = await db.select().from(stripe_early_fraud_warning_actions);
    expect(fraudCases).toHaveLength(1);
    expect(fraudCases[0]).toEqual(
      expect.objectContaining({
        stripe_event_id: 'evt_duplicate_first',
        stripe_early_fraud_warning_id: 'issfr_duplicate',
        status: 'review_required',
      })
    );
    expect(actions).toHaveLength(0);
    expect(retrieveSpy).toHaveBeenCalledTimes(2);

    retrieveSpy.mockRestore();
  });

  test('radar.early_fraud_warning.created classifies organization ownership for review only', async () => {
    await cleanupDbForTest();
    const [organization] = await db
      .insert(organizations)
      .values({ name: 'Warning Review Organization', stripe_customer_id: 'cus_efw_organization' })
      .returning();
    const { client } = await import('@/lib/stripe-client');
    const retrieveSpy = jest
      .spyOn(client.charges, 'retrieve')
      .mockResolvedValue(
        sampleStripeChargeResponse(
          sampleStripeCharge({ id: 'ch_organization', customer: 'cus_efw_organization' })
        )
      );

    await processStripePaymentEventHook(
      sampleEarlyFraudWarningEvent({
        eventId: 'evt_organization',
        warningId: 'issfr_organization',
        charge: 'ch_organization',
      })
    );

    const [fraudCase] = await db.select().from(stripe_early_fraud_warning_cases);
    expect(fraudCase).toEqual(
      expect.objectContaining({
        owner_classification: 'organization',
        kilo_user_id: null,
        organization_id: organization.id,
        status: 'review_required',
        reason: 'Organization-owned warning; manual review required',
      })
    );
    expect(await db.select().from(stripe_early_fraud_warning_actions)).toHaveLength(0);

    retrieveSpy.mockRestore();
  });

  test('radar.early_fraud_warning.created retains ambiguous customer ownership without owner links', async () => {
    await cleanupDbForTest();
    testUser = await insertTestUser({ stripe_customer_id: 'cus_efw_shared' });
    await db
      .insert(organizations)
      .values({ name: 'Shared Customer Organization', stripe_customer_id: 'cus_efw_shared' });
    const { client } = await import('@/lib/stripe-client');
    const retrieveSpy = jest
      .spyOn(client.charges, 'retrieve')
      .mockResolvedValue(
        sampleStripeChargeResponse(
          sampleStripeCharge({ id: 'ch_shared', customer: 'cus_efw_shared' })
        )
      );

    await processStripePaymentEventHook(
      sampleEarlyFraudWarningEvent({
        eventId: 'evt_ambiguous',
        warningId: 'issfr_ambiguous',
        charge: 'ch_shared',
      })
    );

    const [fraudCase] = await db.select().from(stripe_early_fraud_warning_cases);
    expect(fraudCase).toEqual(
      expect.objectContaining({
        owner_classification: 'ambiguous',
        kilo_user_id: null,
        organization_id: null,
        status: 'review_required',
        reason: 'Canonical customer ownership is ambiguous; manual review required',
      })
    );
    expect(await db.select().from(stripe_early_fraud_warning_actions)).toHaveLength(0);

    retrieveSpy.mockRestore();
  });

  test('radar.early_fraud_warning.created retains an already disputed charge for manual review', async () => {
    await cleanupDbForTest();
    testUser = await insertTestUser();
    const { client } = await import('@/lib/stripe-client');
    const retrieveSpy = jest.spyOn(client.charges, 'retrieve').mockResolvedValue(
      sampleStripeChargeResponse(
        sampleStripeCharge({
          id: 'ch_disputed_warning',
          customer: testUser.stripe_customer_id,
          disputed: true,
        })
      )
    );

    await processStripePaymentEventHook(
      sampleEarlyFraudWarningEvent({
        eventId: 'evt_disputed_warning',
        warningId: 'issfr_disputed_warning',
        charge: 'ch_disputed_warning',
      })
    );

    const [fraudCase] = await db.select().from(stripe_early_fraud_warning_cases);
    expect(fraudCase).toEqual(
      expect.objectContaining({
        owner_classification: 'personal',
        kilo_user_id: testUser.id,
        status: 'review_required',
        reason: 'Warned charge is already disputed; manual review required',
      })
    );
    expect(await db.select().from(stripe_early_fraud_warning_actions)).toHaveLength(0);

    retrieveSpy.mockRestore();
  });

  test('radar.early_fraud_warning.created retains unmatched and malformed warnings for review', async () => {
    await cleanupDbForTest();
    const { client } = await import('@/lib/stripe-client');
    const retrieveSpy = jest
      .spyOn(client.charges, 'retrieve')
      .mockResolvedValue(
        sampleStripeChargeResponse(
          sampleStripeCharge({ id: 'ch_unmatched', customer: 'cus_unknown' })
        )
      );

    await processStripePaymentEventHook(
      sampleEarlyFraudWarningEvent({
        eventId: 'evt_unmatched',
        warningId: 'issfr_unmatched',
        charge: 'ch_unmatched',
      })
    );
    await processStripePaymentEventHook(
      sampleEarlyFraudWarningEvent({
        eventId: 'evt_malformed',
        warningId: 'issfr_malformed',
        charge: null,
      })
    );

    const fraudCases = await db
      .select()
      .from(stripe_early_fraud_warning_cases)
      .orderBy(stripe_early_fraud_warning_cases.stripe_early_fraud_warning_id);
    expect(fraudCases).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          stripe_early_fraud_warning_id: 'issfr_unmatched',
          owner_classification: 'unmatched',
          reason: 'No canonical customer owner matched; manual review required',
        }),
        expect.objectContaining({
          stripe_early_fraud_warning_id: 'issfr_malformed',
          stripe_charge_id: null,
          owner_classification: 'unmatched',
          reason: 'Warning does not identify a charge; manual review required',
        }),
      ])
    );
    expect(fraudCases.every(fraudCase => fraudCase.status === 'review_required')).toBe(true);
    expect(await db.select().from(stripe_early_fraud_warning_actions)).toHaveLength(0);
    expect(retrieveSpy).toHaveBeenCalledTimes(1);

    retrieveSpy.mockRestore();
  });

  test('radar.early_fraud_warning.created records retrieval failures as safe review cases', async () => {
    await cleanupDbForTest();
    const { client } = await import('@/lib/stripe-client');
    const retrieveSpy = jest
      .spyOn(client.charges, 'retrieve')
      .mockRejectedValue(new Error('Temporary Stripe retrieval failure'));

    await processStripePaymentEventHook(
      sampleEarlyFraudWarningEvent({
        eventId: 'evt_retrieval_failed',
        warningId: 'issfr_retrieval_failed',
        charge: 'ch_retrieval_failed',
        paymentIntent: 'pi_retrieval_failed',
      })
    );
    await waitForReportEventsCall();

    const [fraudCase] = await db.select().from(stripe_early_fraud_warning_cases);
    expect(fraudCase).toEqual(
      expect.objectContaining({
        stripe_charge_id: 'ch_retrieval_failed',
        stripe_payment_intent_id: 'pi_retrieval_failed',
        stripe_customer_id: null,
        owner_classification: 'unmatched',
        status: 'review_required',
        reason: 'Charge context retrieval failed; manual review required',
        failure_context: 'Stripe charge retrieval failed during warning observation',
      })
    );
    expect(await db.select().from(stripe_early_fraud_warning_actions)).toHaveLength(0);
    expect(retrieveSpy).toHaveBeenCalledTimes(1);
    expect(reportEventsMock).toHaveBeenCalledWith({
      events: [
        {
          type: 'stripe.radar.early_fraud_warning.created',
          occurred_at: 1234567890000,
          data: {
            id: 'evt_retrieval_failed',
            type: 'radar.early_fraud_warning.created',
            charge: 'ch_retrieval_failed',
            payment_intent: 'pi_retrieval_failed',
            early_fraud_warning: 'issfr_retrieval_failed',
          },
        },
      ],
    });

    retrieveSpy.mockRestore();
  });

  test('charge.dispute.funds_withdrawn resolves charge customer for abuse service', async () => {
    const { client } = await import('@/lib/stripe-client');
    const retrieveSpy = jest.spyOn(client.charges, 'retrieve').mockResolvedValue(
      sampleStripeChargeResponse(
        sampleStripeCharge({
          id: 'ch_dispute_withdrawn_123',
          customer: testUser.stripe_customer_id,
          payment_intent: 'pi_dispute_withdrawn_123',
        })
      )
    );

    const event: Stripe.Event = {
      ...baseStripeEvent(),
      id: 'evt_dispute_withdrawn',
      data: {
        object: sampleStripeDispute({
          id: 'dp_withdrawn_123',
          charge: 'ch_dispute_withdrawn_123',
        }),
        previous_attributes: {},
      },
      type: 'charge.dispute.funds_withdrawn',
    };

    await processStripePaymentEventHook(event);
    await waitForReportEventsCall();

    expect(retrieveSpy).toHaveBeenCalledWith('ch_dispute_withdrawn_123');
    expect(reportEventsMock).toHaveBeenCalledWith({
      events: [
        {
          type: 'stripe.charge.dispute.funds_withdrawn',
          occurred_at: 1234567890000,
          data: {
            id: 'evt_dispute_withdrawn',
            type: 'charge.dispute.funds_withdrawn',
            charge: 'ch_dispute_withdrawn_123',
            customer: testUser.stripe_customer_id,
            payment_intent: 'pi_dispute_withdrawn_123',
            dispute: 'dp_withdrawn_123',
          },
        },
      ],
    });

    retrieveSpy.mockRestore();
  });

  test('charge.dispute.created resolves charge customer for abuse service', async () => {
    await cleanupDbForTest();
    testUser = await insertTestUser();

    const { client } = await import('@/lib/stripe-client');
    const kiloClawInvoice = {
      object: 'invoice',
      lines: {
        data: [{ pricing: { price_details: { price: CURRENT_KILOCLAW_STANDARD_PRICE_ID } } }],
      },
    } as unknown as Stripe.Invoice;
    const retrieveSpy = jest.spyOn(client.charges, 'retrieve').mockResolvedValue(
      sampleStripeChargeResponse(
        sampleStripeCharge({
          id: 'ch_dispute_created_123',
          customer: testUser.stripe_customer_id,
          payment_intent: 'pi_dispute_created_123',
        }),
        { invoice: kiloClawInvoice }
      )
    );

    const event: Stripe.Event = {
      ...baseStripeEvent(),
      id: 'evt_dispute_created_abuse',
      data: {
        object: sampleStripeDispute({
          id: 'dp_created_123',
          charge: 'ch_dispute_created_123',
        }),
        previous_attributes: {},
      },
      type: 'charge.dispute.created',
    };

    await processStripePaymentEventHook(event);
    await waitForReportEventsCall();

    const [disputeCase] = await db.select().from(stripe_dispute_cases);
    expect(disputeCase).toEqual(
      expect.objectContaining({
        stripe_dispute_id: 'dp_created_123',
        stripe_event_id: 'evt_dispute_created_abuse',
        stripe_charge_id: 'ch_dispute_created_123',
        stripe_payment_intent_id: 'pi_dispute_created_123',
        stripe_customer_id: testUser.stripe_customer_id,
        amount_minor_units: 2900,
        currency: 'usd',
        dispute_reason: 'fraudulent',
        stripe_status: 'warning_needs_response',
        owner_classification: StripeDisputeOwnerClassification.Personal,
        kilo_user_id: testUser.id,
        status: StripeDisputeCaseStatus.NeedsAction,
      })
    );

    expect(reportEventsMock).toHaveBeenCalledWith({
      events: [
        {
          type: 'stripe.charge.dispute.created',
          occurred_at: 1234567890000,
          data: {
            id: 'evt_dispute_created_abuse',
            type: 'charge.dispute.created',
            charge: 'ch_dispute_created_123',
            customer: testUser.stripe_customer_id,
            payment_intent: 'pi_dispute_created_123',
            dispute: 'dp_created_123',
          },
        },
      ],
    });

    retrieveSpy.mockRestore();
  });

  test('charge.dispute.created persists dispute case when charge enrichment fails', async () => {
    await cleanupDbForTest();

    const { client } = await import('@/lib/stripe-client');
    const retrieveSpy = jest
      .spyOn(client.charges, 'retrieve')
      .mockRejectedValue(new Error('charge retrieve failed'));
    const event: Stripe.Event = {
      ...baseStripeEvent(),
      id: 'evt_dispute_created_enrichment_failed',
      data: {
        object: sampleStripeDispute({
          id: 'dp_created_enrichment_failed',
          charge: 'ch_dispute_enrichment_failed',
          payment_intent: 'pi_dispute_enrichment_failed',
          status: 'needs_response',
        }),
        previous_attributes: {},
      },
      type: 'charge.dispute.created',
    };

    await expect(processStripePaymentEventHook(event)).rejects.toThrow('charge retrieve failed');

    const [disputeCase] = await db.select().from(stripe_dispute_cases);
    expect(disputeCase).toEqual(
      expect.objectContaining({
        stripe_dispute_id: 'dp_created_enrichment_failed',
        stripe_event_id: 'evt_dispute_created_enrichment_failed',
        stripe_charge_id: 'ch_dispute_enrichment_failed',
        stripe_payment_intent_id: 'pi_dispute_enrichment_failed',
        stripe_customer_id: null,
        stripe_status: 'needs_response',
        owner_classification: StripeDisputeOwnerClassification.Unmatched,
        kilo_user_id: null,
        organization_id: null,
        status: StripeDisputeCaseStatus.ReviewRequired,
      })
    );

    retrieveSpy.mockRestore();
  });

  test('charge.dispute.closed updates an existing dispute case', async () => {
    await cleanupDbForTest();
    testUser = await insertTestUser();

    await db.insert(stripe_dispute_cases).values({
      stripe_dispute_id: 'dp_closed_123',
      stripe_event_id: 'evt_dispute_created_original',
      stripe_charge_id: 'ch_dispute_closed_123',
      stripe_customer_id: testUser.stripe_customer_id,
      owner_classification: StripeDisputeOwnerClassification.Personal,
      kilo_user_id: testUser.id,
      status: StripeDisputeCaseStatus.NeedsAction,
      status_reason: 'Canonical personal owner matched; admin action required',
      stripe_status: 'needs_response',
    });

    const { client } = await import('@/lib/stripe-client');
    const retrieveSpy = jest.spyOn(client.charges, 'retrieve').mockResolvedValue(
      sampleStripeChargeResponse(
        sampleStripeCharge({
          id: 'ch_dispute_closed_123',
          customer: testUser.stripe_customer_id,
          payment_intent: 'pi_dispute_closed_123',
        })
      )
    );
    const event: Stripe.Event = {
      ...baseStripeEvent(),
      id: 'evt_dispute_closed',
      data: {
        object: sampleStripeDispute({
          id: 'dp_closed_123',
          charge: 'ch_dispute_closed_123',
          payment_intent: 'pi_dispute_closed_123',
          status: 'lost',
        }),
        previous_attributes: {},
      },
      type: 'charge.dispute.closed',
    };

    await processStripePaymentEventHook(event);

    const [disputeCase] = await db
      .select()
      .from(stripe_dispute_cases)
      .where(eq(stripe_dispute_cases.stripe_dispute_id, 'dp_closed_123'));
    expect(disputeCase).toEqual(
      expect.objectContaining({
        stripe_event_id: 'evt_dispute_closed',
        stripe_payment_intent_id: 'pi_dispute_closed_123',
        stripe_status: 'lost',
        status: StripeDisputeCaseStatus.Closed,
      })
    );

    retrieveSpy.mockRestore();
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

  test('charge.dispute.created enqueues sale reversal for matched charge', async () => {
    await cleanupDbForTest();
    testUser = await insertTestUser();

    await db.insert(user_affiliate_attributions).values({
      user_id: testUser.id,
      provider: 'impact',
      tracking_id: 'impact-click-123',
    });

    await db.insert(user_affiliate_events).values({
      user_id: testUser.id,
      provider: 'impact',
      event_type: 'sale',
      dedupe_key: 'affiliate:impact:sale:invoice-123',
      delivery_state: 'delivered',
      payload_json: {
        trackingId: 'impact-click-123',
        customerId: testUser.id,
        customerEmailHash: 'hashed-email',
        orderId: 'invoice-123',
        eventDate: '2026-04-09T10:00:00.000Z',
        amount: 29,
        currencyCode: 'usd',
        stripeChargeId: 'ch_dispute_123',
        impactActionId: '1000.2000.3000',
      },
      stripe_charge_id: 'ch_dispute_123',
      impact_action_id: '1000.2000.3000',
    });

    const retrieveSpy = await mockChargeRetrieveForKiloClaw(CURRENT_KILOCLAW_STANDARD_PRICE_ID);

    const event: Stripe.Event = {
      ...baseStripeEvent(),
      id: 'evt_dispute_created',
      type: 'charge.dispute.created',
      data: {
        object: sampleStripeDispute({
          id: 'dp_123',
          charge: 'ch_dispute_123',
        }),
        previous_attributes: {},
      },
    };

    await processStripePaymentEventHook(event);
    retrieveSpy.mockRestore();

    const reversalEvents = await db
      .select()
      .from(user_affiliate_events)
      .where(eq(user_affiliate_events.event_type, 'sale_reversal'));

    expect(reversalEvents).toHaveLength(1);
    expect(reversalEvents[0]).toMatchObject({
      user_id: testUser.id,
      parent_event_id: expect.any(String),
      delivery_state: 'queued',
      stripe_charge_id: 'ch_dispute_123',
      dedupe_key: 'affiliate:impact:sale_reversal:ch_dispute_123',
    });
    expect(reversalEvents[0]?.payload_json.disputeId).toBe('dp_123');
  });

  test('charge.dispute.created maps a metadata-resolved Kilo Pass partial dispute to its sale reversal', async () => {
    await cleanupDbForTest();
    testUser = await insertTestUser();

    await db.insert(user_affiliate_attributions).values({
      user_id: testUser.id,
      provider: 'impact',
      tracking_id: 'impact-click-123',
    });

    await db.insert(user_affiliate_events).values({
      user_id: testUser.id,
      provider: 'impact',
      event_type: 'sale',
      dedupe_key: 'affiliate:impact:sale:in_kilo_pass_metadata_dispute',
      delivery_state: 'delivered',
      payload_json: {
        trackingId: 'impact-click-123',
        customerId: testUser.id,
        customerEmailHash: 'hashed-email',
        orderId: 'in_kilo_pass_metadata_dispute',
        eventDate: '2026-04-09T10:00:00.000Z',
        amount: 29,
        currencyCode: 'usd',
        stripeChargeId: 'ch_kilo_pass_metadata_dispute',
        impactActionId: '1000.2000.3000',
      },
      stripe_charge_id: 'ch_kilo_pass_metadata_dispute',
      impact_action_id: '1000.2000.3000',
    });

    const { client } = await import('@/lib/stripe-client');
    const kiloPassInvoice = {
      id: 'in_kilo_pass_metadata_dispute',
      object: 'invoice',
      parent: {
        subscription_details: {
          metadata: {
            type: 'kilo-pass',
            kiloUserId: testUser.id,
            tier: KiloPassTier.Tier19,
            cadence: KiloPassCadence.Monthly,
          },
        },
      },
      lines: { data: [] },
    } as unknown as Stripe.Invoice;
    const retrieveSpy = jest.spyOn(client.charges, 'retrieve').mockResolvedValue({
      invoice: kiloPassInvoice,
      lastResponse: { headers: {}, requestId: 'req_test', statusCode: 200 },
    } as unknown as Stripe.Response<Stripe.Charge>);

    const event: Stripe.Event = {
      ...baseStripeEvent(),
      id: 'evt_dispute_kilo_pass_metadata_partial',
      type: 'charge.dispute.created',
      data: {
        object: sampleStripeDispute({
          id: 'dp_kilo_pass_metadata_partial',
          charge: 'ch_kilo_pass_metadata_dispute',
          amount: 900,
        }),
        previous_attributes: {},
      },
    };

    await processStripePaymentEventHook(event);
    retrieveSpy.mockRestore();

    const reversalEvents = await db
      .select()
      .from(user_affiliate_events)
      .where(eq(user_affiliate_events.event_type, 'sale_reversal'));

    expect(reversalEvents).toHaveLength(1);
    expect(reversalEvents[0]).toMatchObject({
      user_id: testUser.id,
      delivery_state: 'queued',
      stripe_charge_id: 'ch_kilo_pass_metadata_dispute',
      dedupe_key: 'affiliate:impact:sale_reversal:ch_kilo_pass_metadata_dispute',
    });
    expect(reversalEvents[0]?.payload_json.disputeId).toBe('dp_kilo_pass_metadata_partial');
  });

  test('charge.dispute.created marks applied Kilo Pass referral rewards for support review', async () => {
    await cleanupDbForTest();
    testUser = await insertTestUser();
    const invoiceId = 'in_kilo_pass_referral_dispute';
    const rewardId = await seedKiloPassReferralReward({
      userId: testUser.id,
      invoiceId,
      status: ImpactReferralRewardStatus.Applied,
    });
    const retrieveSpy = await mockChargeRetrieveForKiloPass(invoiceId, testUser.id);

    const event: Stripe.Event = {
      ...baseStripeEvent(),
      id: 'evt_dispute_kilo_pass_referral_reward',
      type: 'charge.dispute.created',
      data: {
        object: sampleStripeDispute({
          id: 'dp_kilo_pass_referral_reward',
          charge: 'ch_kilo_pass_referral_dispute',
        }),
        previous_attributes: {},
      },
    };

    await processStripePaymentEventHook(event);
    retrieveSpy.mockRestore();

    const reward = await db.query.impact_referral_rewards.findFirst({
      where: eq(impact_referral_rewards.id, rewardId),
    });
    expect(reward).toEqual(
      expect.objectContaining({
        status: ImpactReferralRewardStatus.ReviewRequired,
        review_reason: 'referral_payment_chargeback',
      })
    );
  });

  test('charge.refunded cancels pending Kilo Pass referral rewards by Stripe invoice identity', async () => {
    await cleanupDbForTest();
    testUser = await insertTestUser();
    const invoiceId = 'in_kilo_pass_referral_refund';
    const rewardId = await seedKiloPassReferralReward({
      userId: testUser.id,
      invoiceId,
      status: ImpactReferralRewardStatus.Pending,
    });
    const retrieveSpy = await mockChargeRetrieveForKiloPass(invoiceId, testUser.id);

    const event: Stripe.Event = {
      ...baseStripeEvent(),
      id: 'evt_refund_kilo_pass_referral_reward',
      type: 'charge.refunded',
      data: {
        object: {
          id: 'ch_kilo_pass_referral_refund',
          object: 'charge',
          amount_refunded: 1900,
          created: 1712743200,
        } as unknown as Stripe.Charge,
        previous_attributes: {},
      },
    };

    await processStripePaymentEventHook(event);
    retrieveSpy.mockRestore();

    const reward = await db.query.impact_referral_rewards.findFirst({
      where: eq(impact_referral_rewards.id, rewardId),
    });
    expect(reward).toEqual(
      expect.objectContaining({
        status: ImpactReferralRewardStatus.Canceled,
        review_reason: 'referral_payment_refund',
      })
    );
  });

  test('charge.updated fraud marking cancels earned Kilo Pass referral rewards by Stripe invoice identity', async () => {
    await cleanupDbForTest();
    testUser = await insertTestUser();
    const invoiceId = 'in_kilo_pass_referral_fraud';
    const rewardId = await seedKiloPassReferralReward({
      userId: testUser.id,
      invoiceId,
      status: ImpactReferralRewardStatus.Earned,
    });
    const retrieveSpy = await mockChargeRetrieveForKiloPass(invoiceId, testUser.id);

    const event: Stripe.Event = {
      ...baseStripeEvent(),
      id: 'evt_fraud_kilo_pass_referral_reward',
      type: 'charge.updated',
      data: {
        object: {
          id: 'ch_kilo_pass_referral_fraud',
          object: 'charge',
          created: 1712743200,
          fraud_details: { stripe_report: 'fraudulent' },
        } as unknown as Stripe.Charge,
        previous_attributes: {},
      },
    };

    await processStripePaymentEventHook(event);
    retrieveSpy.mockRestore();

    const reward = await db.query.impact_referral_rewards.findFirst({
      where: eq(impact_referral_rewards.id, rewardId),
    });
    expect(reward).toEqual(
      expect.objectContaining({
        status: ImpactReferralRewardStatus.Canceled,
        review_reason: 'referral_payment_fraud',
      })
    );
  });

  test('charge.dispute.created persists pending row for unmatched KiloClaw charge', async () => {
    await cleanupDbForTest();
    testUser = await insertTestUser();

    const retrieveSpy = await mockChargeRetrieveForKiloClaw(CURRENT_KILOCLAW_STANDARD_PRICE_ID);

    const event: Stripe.Event = {
      ...baseStripeEvent(),
      id: 'evt_dispute_unmatched',
      type: 'charge.dispute.created',
      data: {
        object: sampleStripeDispute({
          id: 'dp_unmatched',
          charge: 'ch_missing',
        }),
        previous_attributes: {},
      },
    };

    await processStripePaymentEventHook(event);
    retrieveSpy.mockRestore();

    const reversalEvents = await db
      .select()
      .from(user_affiliate_events)
      .where(eq(user_affiliate_events.event_type, 'sale_reversal'));
    const pendingRows = await db.select().from(pending_impact_sale_reversals);

    expect(reversalEvents).toHaveLength(0);
    expect(pendingRows).toHaveLength(1);
    expect(pendingRows[0]).toMatchObject({
      stripe_charge_id: 'ch_missing',
      dispute_id: 'dp_unmatched',
    });
  });

  test('charge.dispute.created does nothing when charge id is missing', async () => {
    await cleanupDbForTest();
    testUser = await insertTestUser();

    const event: Stripe.Event = {
      ...baseStripeEvent(),
      id: 'evt_dispute_missing_charge',
      type: 'charge.dispute.created',
      data: {
        object: sampleStripeDispute({
          id: 'dp_missing_charge',
          charge: '',
        }),
        previous_attributes: {},
      },
    };

    await processStripePaymentEventHook(event);

    const reversalEvents = await db
      .select()
      .from(user_affiliate_events)
      .where(eq(user_affiliate_events.event_type, 'sale_reversal'));

    expect(reversalEvents).toHaveLength(0);
  });

  test('charge.dispute.created skips legacy delivered sale without stored mapping', async () => {
    await cleanupDbForTest();
    testUser = await insertTestUser();

    await db.insert(user_affiliate_attributions).values({
      user_id: testUser.id,
      provider: 'impact',
      tracking_id: 'impact-click-123',
    });

    await db.insert(user_affiliate_events).values({
      user_id: testUser.id,
      provider: 'impact',
      event_type: 'sale',
      dedupe_key: 'affiliate:impact:sale:legacy-invoice-123',
      delivery_state: 'delivered',
      payload_json: {
        trackingId: 'impact-click-123',
        customerId: testUser.id,
        customerEmailHash: 'hashed-email',
        orderId: 'legacy-invoice-123',
        eventDate: '2026-04-09T10:00:00.000Z',
        amount: 29,
        currencyCode: 'usd',
        stripeChargeId: 'ch_legacy_missing_mapping',
      },
      stripe_charge_id: 'ch_legacy_missing_mapping',
    });

    const retrieveSpy = await mockChargeRetrieveForKiloClaw(CURRENT_KILOCLAW_STANDARD_PRICE_ID);

    const event: Stripe.Event = {
      ...baseStripeEvent(),
      id: 'evt_dispute_legacy',
      type: 'charge.dispute.created',
      data: {
        object: sampleStripeDispute({
          id: 'dp_legacy',
          charge: 'ch_legacy_missing_mapping',
        }),
        previous_attributes: {},
      },
    };

    await processStripePaymentEventHook(event);
    retrieveSpy.mockRestore();

    const reversalEvents = await db
      .select()
      .from(user_affiliate_events)
      .where(eq(user_affiliate_events.event_type, 'sale_reversal'));

    expect(reversalEvents).toHaveLength(0);
  });

  test('charge.dispute.created persists pending row for unmatched Kilo Pass invoice charge', async () => {
    await cleanupDbForTest();
    testUser = await insertTestUser();

    const { client } = await import('@/lib/stripe-client');
    const kiloPassInvoice = {
      id: 'in_kilo_pass_pending',
      object: 'invoice',
      lines: {
        data: [
          { pricing: { price_details: { price: CURRENT_KILO_PASS_TIER_19_MONTHLY_PRICE_ID } } },
        ],
      },
    } as unknown as Stripe.Invoice;
    const retrieveSpy = jest.spyOn(client.charges, 'retrieve').mockResolvedValue({
      invoice: kiloPassInvoice,
      lastResponse: { headers: {}, requestId: 'req_test', statusCode: 200 },
    } as unknown as Stripe.Response<Stripe.Charge>);

    const event: Stripe.Event = {
      ...baseStripeEvent(),
      id: 'evt_dispute_kilo_pass_pending',
      type: 'charge.dispute.created',
      data: {
        object: sampleStripeDispute({
          id: 'dp_kilo_pass_pending',
          charge: 'ch_kilo_pass_missing',
        }),
        previous_attributes: {},
      },
    };

    await processStripePaymentEventHook(event);

    const reversalEvents = await db
      .select()
      .from(user_affiliate_events)
      .where(eq(user_affiliate_events.event_type, 'sale_reversal'));
    const pendingRows = await db.select().from(pending_impact_sale_reversals);

    expect(reversalEvents).toHaveLength(0);
    expect(pendingRows).toHaveLength(1);
    expect(pendingRows[0]).toMatchObject({
      stripe_charge_id: 'ch_kilo_pass_missing',
      dispute_id: 'dp_kilo_pass_pending',
    });

    retrieveSpy.mockRestore();
  });

  test('charge.dispute.created dedupes duplicate pending Kilo Pass reversal intent', async () => {
    await cleanupDbForTest();
    testUser = await insertTestUser();

    const { client } = await import('@/lib/stripe-client');
    const kiloPassInvoice = {
      id: 'in_kilo_pass_duplicate',
      object: 'invoice',
      lines: {
        data: [
          { pricing: { price_details: { price: CURRENT_KILO_PASS_TIER_19_MONTHLY_PRICE_ID } } },
        ],
      },
    } as unknown as Stripe.Invoice;
    const retrieveSpy = jest.spyOn(client.charges, 'retrieve').mockResolvedValue({
      invoice: kiloPassInvoice,
      lastResponse: { headers: {}, requestId: 'req_test', statusCode: 200 },
    } as unknown as Stripe.Response<Stripe.Charge>);

    const firstEvent: Stripe.Event = {
      ...baseStripeEvent(),
      id: 'evt_dispute_kilo_pass_duplicate_first',
      type: 'charge.dispute.created',
      data: {
        object: sampleStripeDispute({
          id: 'dp_kilo_pass_duplicate_first',
          charge: 'ch_kilo_pass_duplicate',
        }),
        previous_attributes: {},
      },
    };
    const secondEvent: Stripe.Event = {
      ...baseStripeEvent(),
      id: 'evt_dispute_kilo_pass_duplicate_second',
      type: 'charge.dispute.created',
      data: {
        object: sampleStripeDispute({
          id: 'dp_kilo_pass_duplicate_second',
          charge: 'ch_kilo_pass_duplicate',
        }),
        previous_attributes: {},
      },
    };

    await processStripePaymentEventHook(firstEvent);
    await processStripePaymentEventHook(secondEvent);

    const reversalEvents = await db
      .select()
      .from(user_affiliate_events)
      .where(eq(user_affiliate_events.event_type, 'sale_reversal'));
    const pendingRows = await db.select().from(pending_impact_sale_reversals);

    expect(reversalEvents).toHaveLength(0);
    expect(pendingRows).toHaveLength(1);
    expect(pendingRows[0]).toMatchObject({
      stripe_charge_id: 'ch_kilo_pass_duplicate',
      dispute_id: 'dp_kilo_pass_duplicate_first',
    });

    retrieveSpy.mockRestore();
  });

  test('duplicate deferred Kilo Pass disputes materialize one reversal after sale identity is recoverable', async () => {
    await cleanupDbForTest();
    testUser = await insertTestUser();

    const { client } = await import('@/lib/stripe-client');
    const kiloPassInvoice = {
      id: 'in_kilo_pass_deferred_materialization',
      object: 'invoice',
      parent: {
        subscription_details: {
          metadata: {
            type: 'kilo-pass',
            kiloUserId: testUser.id,
            tier: KiloPassTier.Tier19,
            cadence: KiloPassCadence.Monthly,
          },
        },
      },
      lines: { data: [] },
    } as unknown as Stripe.Invoice;
    const retrieveSpy = jest.spyOn(client.charges, 'retrieve').mockResolvedValue({
      invoice: kiloPassInvoice,
      lastResponse: { headers: {}, requestId: 'req_test', statusCode: 200 },
    } as unknown as Stripe.Response<Stripe.Charge>);

    const firstEvent: Stripe.Event = {
      ...baseStripeEvent(),
      id: 'evt_dispute_kilo_pass_deferred_first',
      type: 'charge.dispute.created',
      data: {
        object: sampleStripeDispute({
          id: 'dp_kilo_pass_deferred_first',
          charge: 'ch_kilo_pass_deferred_materialization',
        }),
        previous_attributes: {},
      },
    };
    const duplicateEvent: Stripe.Event = {
      ...baseStripeEvent(),
      id: 'evt_dispute_kilo_pass_deferred_duplicate',
      type: 'charge.dispute.created',
      data: {
        object: sampleStripeDispute({
          id: 'dp_kilo_pass_deferred_duplicate',
          charge: 'ch_kilo_pass_deferred_materialization',
        }),
        previous_attributes: {},
      },
    };

    await processStripePaymentEventHook(firstEvent);
    await processStripePaymentEventHook(duplicateEvent);

    await db.insert(user_affiliate_events).values({
      user_id: testUser.id,
      provider: 'impact',
      event_type: 'sale',
      dedupe_key: 'affiliate:impact:sale:in_kilo_pass_deferred_materialization',
      delivery_state: 'delivered',
      payload_json: {
        trackingId: 'impact-click-123',
        customerId: testUser.id,
        customerEmailHash: 'hashed-email',
        orderId: 'in_kilo_pass_deferred_materialization',
        eventDate: '2026-04-09T10:00:00.000Z',
        amount: 29,
        currencyCode: 'usd',
        stripeChargeId: 'ch_kilo_pass_deferred_materialization',
        impactActionId: '1000.2000.3000',
      },
      stripe_charge_id: 'ch_kilo_pass_deferred_materialization',
    });

    const { dispatchQueuedAffiliateEvents } = await import('@/lib/impact/affiliate-events');
    await dispatchQueuedAffiliateEvents();

    const pendingRows = await db.select().from(pending_impact_sale_reversals);
    const reversalEvents = await db
      .select()
      .from(user_affiliate_events)
      .where(eq(user_affiliate_events.event_type, 'sale_reversal'));

    expect(pendingRows).toHaveLength(0);
    expect(reversalEvents).toHaveLength(1);
    expect(reversalEvents[0]).toMatchObject({
      parent_event_id: expect.any(String),
      stripe_charge_id: 'ch_kilo_pass_deferred_materialization',
      dedupe_key: 'affiliate:impact:sale_reversal:ch_kilo_pass_deferred_materialization',
    });
    expect(reversalEvents[0]?.payload_json.disputeId).toBe('dp_kilo_pass_deferred_first');

    retrieveSpy.mockRestore();
  });

  test('charge.dispute.closed won resolution does not auto-restore a reversed affiliate commission', async () => {
    await cleanupDbForTest();
    testUser = await insertTestUser();

    await db.insert(user_affiliate_events).values({
      user_id: testUser.id,
      provider: 'impact',
      event_type: 'sale_reversal',
      dedupe_key: 'affiliate:impact:sale_reversal:ch_kilo_pass_won_dispute',
      delivery_state: 'delivered',
      payload_json: {
        trackingId: 'impact-click-123',
        customerId: testUser.id,
        customerEmailHash: 'hashed-email',
        orderId: 'in_kilo_pass_won_dispute',
        eventDate: '2026-04-10T10:00:00.000Z',
        amount: 29,
        currencyCode: 'usd',
        stripeChargeId: 'ch_kilo_pass_won_dispute',
        impactActionId: '1000.2000.3000',
        disputeId: 'dp_kilo_pass_won_dispute',
      },
      stripe_charge_id: 'ch_kilo_pass_won_dispute',
      impact_action_id: '1000.2000.3000',
    });

    const { client } = await import('@/lib/stripe-client');
    const retrieveSpy = jest.spyOn(client.charges, 'retrieve').mockResolvedValue(
      sampleStripeChargeResponse(
        sampleStripeCharge({
          id: 'ch_kilo_pass_won_dispute',
          customer: testUser.stripe_customer_id,
        })
      )
    );

    const event: Stripe.Event = {
      ...baseStripeEvent(),
      id: 'evt_dispute_kilo_pass_won_resolution',
      type: 'charge.dispute.closed',
      data: {
        object: sampleStripeDispute({
          id: 'dp_kilo_pass_won_dispute',
          charge: 'ch_kilo_pass_won_dispute',
          status: 'won',
        }),
        previous_attributes: {},
      },
    };

    await processStripePaymentEventHook(event);

    const affiliateEvents = await db.select().from(user_affiliate_events);
    const pendingRows = await db.select().from(pending_impact_sale_reversals);

    expect(affiliateEvents).toHaveLength(1);
    expect(affiliateEvents[0]).toMatchObject({
      event_type: 'sale_reversal',
      delivery_state: 'delivered',
      dedupe_key: 'affiliate:impact:sale_reversal:ch_kilo_pass_won_dispute',
    });
    expect(pendingRows).toHaveLength(0);

    retrieveSpy.mockRestore();
  });

  test('charge.dispute.created skips unrelated invoice charge disputes', async () => {
    await cleanupDbForTest();
    testUser = await insertTestUser();

    const { client } = await import('@/lib/stripe-client');
    const unrelatedInvoice = {
      id: 'in_unrelated_dispute',
      object: 'invoice',
      lines: {
        data: [{ pricing: { price_details: { price: 'price_unrelated_dispute' } } }],
      },
    } as unknown as Stripe.Invoice;
    const retrieveSpy = jest.spyOn(client.charges, 'retrieve').mockResolvedValue({
      invoice: unrelatedInvoice,
      lastResponse: { headers: {}, requestId: 'req_test', statusCode: 200 },
    } as unknown as Stripe.Response<Stripe.Charge>);

    const event: Stripe.Event = {
      ...baseStripeEvent(),
      id: 'evt_dispute_unrelated_invoice',
      type: 'charge.dispute.created',
      data: {
        object: sampleStripeDispute({
          id: 'dp_unrelated_invoice',
          charge: 'ch_unrelated_invoice',
        }),
        previous_attributes: {},
      },
    };

    await processStripePaymentEventHook(event);

    const reversalEvents = await db
      .select()
      .from(user_affiliate_events)
      .where(eq(user_affiliate_events.event_type, 'sale_reversal'));
    const pendingRows = await db.select().from(pending_impact_sale_reversals);

    expect(reversalEvents).toHaveLength(0);
    expect(pendingRows).toHaveLength(0);

    retrieveSpy.mockRestore();
  });

  test('charge.dispute.created skips charge disputes without an eligible invoice', async () => {
    await cleanupDbForTest();
    testUser = await insertTestUser();

    const { client } = await import('@/lib/stripe-client');
    const retrieveSpy = jest.spyOn(client.charges, 'retrieve').mockResolvedValue({
      invoice: null,
      lastResponse: { headers: {}, requestId: 'req_test', statusCode: 200 },
    } as unknown as Stripe.Response<Stripe.Charge>);

    const event: Stripe.Event = {
      ...baseStripeEvent(),
      id: 'evt_dispute_without_invoice',
      type: 'charge.dispute.created',
      data: {
        object: sampleStripeDispute({
          id: 'dp_without_invoice',
          charge: 'ch_without_invoice',
        }),
        previous_attributes: {},
      },
    };

    await processStripePaymentEventHook(event);

    const reversalEvents = await db
      .select()
      .from(user_affiliate_events)
      .where(eq(user_affiliate_events.event_type, 'sale_reversal'));
    const pendingRows = await db.select().from(pending_impact_sale_reversals);

    expect(reversalEvents).toHaveLength(0);
    expect(pendingRows).toHaveLength(0);

    retrieveSpy.mockRestore();
  });

  test('charge.dispute.created propagates errors from Stripe so the webhook retries', async () => {
    await cleanupDbForTest();
    testUser = await insertTestUser();

    const { client } = await import('@/lib/stripe-client');
    const retrieveSpy = jest
      .spyOn(client.charges, 'retrieve')
      .mockRejectedValue(new Error('Stripe API unavailable'));

    const event: Stripe.Event = {
      ...baseStripeEvent(),
      id: 'evt_dispute_stripe_err',
      type: 'charge.dispute.created',
      data: {
        object: sampleStripeDispute({
          id: 'dp_stripe_err',
          charge: 'ch_stripe_err',
        }),
        previous_attributes: {},
      },
    };

    await expect(processStripePaymentEventHook(event)).rejects.toThrow('Stripe API unavailable');

    const pendingRows = await db.select().from(pending_impact_sale_reversals);
    expect(pendingRows).toHaveLength(0);

    retrieveSpy.mockRestore();
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
        provider_subscription_id: stripeSubscriptionId,
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
        provider_subscription_id: stripeSubscriptionId,
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
        effective_at: '2099-02-01T00:00:00.000Z',
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

      const auditLog = await db.query.kilo_pass_audit_log.findFirst({
        where: eq(kilo_pass_audit_log.stripe_event_id, event.id),
      });
      expect(auditLog?.stripe_subscription_id).toBe(stripeSubscriptionId);
      expect(auditLog?.payload_json).toEqual(
        expect.objectContaining({
          scheduleId,
          scheduledChangeId,
          scheduleStatus: KiloPassScheduledChangeStatus.Released,
          effectiveAt: '2099-02-01T00:00:00.000Z',
          unexpectedPreEffectiveRelease: true,
        })
      );
    });

    test('subscription_schedule.updated (status=canceled) soft-deletes the scheduled change row', async () => {
      const stripeSubscriptionId = `sub_kilo_pass_cancel_${Math.random()}`;
      const scheduleId = `sub_sched_cancel_${Math.random()}`;
      const scheduledChangeId = crypto.randomUUID();

      await db.insert(kilo_pass_subscriptions).values({
        kilo_user_id: testUser.id,
        provider_subscription_id: stripeSubscriptionId,
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
        provider_subscription_id: stripeSubscriptionId,
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
  test('only the caller that claims the row releases Stripe under concurrent reads', async () => {
    const scheduledChangeId = crypto.randomUUID();
    const stripeSubId = `sub_release_helper_concurrent_${Math.random()}`;
    const scheduleId = `sched_release_helper_concurrent_${Math.random()}`;
    const user = await insertTestUser({
      google_user_email: 'kilo-pass-release-helper-concurrent@example.com',
    });
    await db.insert(kilo_pass_subscriptions).values({
      kilo_user_id: user.id,
      provider_subscription_id: stripeSubId,
      stripe_subscription_id: stripeSubId,
      tier: KiloPassTier.Tier19,
      cadence: KiloPassCadence.Monthly,
      status: 'active',
      cancel_at_period_end: false,
      current_streak_months: 1,
      started_at: '2026-01-01T00:00:00.000Z',
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
      effective_at: '2026-02-01T00:00:00.000Z',
      status: KiloPassScheduledChangeStatus.NotStarted,
    });

    const realFindFirst = db.query.kilo_pass_scheduled_changes.findFirst.bind(
      db.query.kilo_pass_scheduled_changes
    );
    let readers = 0;
    let releaseReaders: (() => void) | null = null;
    const bothRead = new Promise<void>(resolve => {
      releaseReaders = resolve;
    });
    const concurrentDb = new Proxy(db, {
      get(target, property, receiver) {
        if (property !== 'query') return Reflect.get(target, property, receiver);
        return {
          ...target.query,
          kilo_pass_scheduled_changes: {
            ...target.query.kilo_pass_scheduled_changes,
            findFirst: async (...args: Parameters<typeof realFindFirst>) => {
              const row = await realFindFirst(...args);
              readers += 1;
              if (readers === 2) releaseReaders?.();
              await bothRead;
              return row;
            },
          },
        };
      },
    });
    const release = jest.fn(async (_scheduleId: string) => ({}));
    const retrieve = jest.fn(async (_scheduleId: string) => ({ status: 'released' }));
    const params = {
      dbOrTx: concurrentDb,
      stripe: { subscriptionSchedules: { release, retrieve } },
      stripeSubscriptionId: stripeSubId,
      reason: 'cancel_scheduled_change' as const,
    };

    await Promise.all([
      releaseScheduledChangeForSubscription(params),
      releaseScheduledChangeForSubscription(params),
    ]);

    expect(release).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledWith(scheduleId);
    const row = await db.query.kilo_pass_scheduled_changes.findFirst({
      where: eq(kilo_pass_scheduled_changes.id, scheduledChangeId),
    });
    expect(row?.status).toBe(KiloPassScheduledChangeStatus.Released);
    expect(row?.deleted_at).not.toBeNull();
  });

  test('a concurrent caller does not report success while the claimed release fails', async () => {
    const scheduledChangeId = crypto.randomUUID();
    const stripeSubId = `sub_release_helper_concurrent_failure_${Math.random()}`;
    const scheduleId = `sched_release_helper_concurrent_failure_${Math.random()}`;
    const user = await insertTestUser({
      google_user_email: 'kilo-pass-release-helper-concurrent-failure@example.com',
    });
    await db.insert(kilo_pass_subscriptions).values({
      kilo_user_id: user.id,
      provider_subscription_id: stripeSubId,
      stripe_subscription_id: stripeSubId,
      tier: KiloPassTier.Tier19,
      cadence: KiloPassCadence.Monthly,
      status: 'active',
      cancel_at_period_end: false,
      current_streak_months: 1,
      started_at: '2026-01-01T00:00:00.000Z',
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
      effective_at: '2026-02-01T00:00:00.000Z',
      status: KiloPassScheduledChangeStatus.NotStarted,
    });

    const realFindFirst = db.query.kilo_pass_scheduled_changes.findFirst.bind(
      db.query.kilo_pass_scheduled_changes
    );
    let readers = 0;
    let releaseReaders: (() => void) | null = null;
    const bothRead = new Promise<void>(resolve => {
      releaseReaders = resolve;
    });
    const concurrentDb = new Proxy(db, {
      get(target, property, receiver) {
        if (property !== 'query') return Reflect.get(target, property, receiver);
        return {
          ...target.query,
          kilo_pass_scheduled_changes: {
            ...target.query.kilo_pass_scheduled_changes,
            findFirst: async (...args: Parameters<typeof realFindFirst>) => {
              const row = await realFindFirst(...args);
              readers += 1;
              if (readers === 2) releaseReaders?.();
              await bothRead;
              return row;
            },
          },
        };
      },
    });
    const release = jest.fn(async (_scheduleId: string) => {
      throw new Error('stripe release failed');
    });
    const retrieve = jest.fn(async (_scheduleId: string) => ({ status: 'active' }));
    const params = {
      dbOrTx: concurrentDb,
      stripe: { subscriptionSchedules: { release, retrieve } },
      stripeSubscriptionId: stripeSubId,
      reason: 'cancel_scheduled_change' as const,
    };

    const results = await Promise.allSettled([
      releaseScheduledChangeForSubscription(params),
      releaseScheduledChangeForSubscription(params),
    ]);

    expect(results.every(result => result.status === 'rejected')).toBe(true);
    expect(release).toHaveBeenCalledTimes(1);
    const row = await db.query.kilo_pass_scheduled_changes.findFirst({
      where: eq(kilo_pass_scheduled_changes.id, scheduledChangeId),
    });
    expect(row?.status).toBe(KiloPassScheduledChangeStatus.NotStarted);
    expect(row?.deleted_at).toBeNull();
  });

  test('soft-deletes first and reverts the delete if Stripe release fails', async () => {
    const scheduledChangeId = crypto.randomUUID();
    const stripeSubId = `sub_release_helper_${Math.random()}`;
    const scheduleId = `sched_release_helper_${Math.random()}`;

    const user = await insertTestUser({
      google_user_email: 'kilo-pass-release-helper-revert@example.com',
    });

    await db.insert(kilo_pass_subscriptions).values({
      kilo_user_id: user.id,
      provider_subscription_id: stripeSubId,
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
      provider_subscription_id: stripeSubId,
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
      created: SERVICE_FEE_ACTIVATION_UNIX_SECONDS,
    }) as unknown as Stripe.Charge;

  const withTopUpPrincipalMetadata = (
    metadata: StripeTopupMetadata,
    principalMinor: number
  ): StripeTopupMetadata => ({
    ...metadata,
    amountCents: String(principalMinor),
    serviceFeePrincipalMinor: String(principalMinor),
  });

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

  let listCheckoutSessionsSpy: { mockRestore: () => void } | undefined;

  beforeEach(async () => {
    const { client } = await import('@/lib/stripe-client');
    listCheckoutSessionsSpy = jest.spyOn(client.checkout.sessions, 'list').mockResolvedValue({
      object: 'list',
      data: [],
      has_more: false,
      url: '/v1/checkout/sessions',
    } as unknown as Stripe.Response<Stripe.ApiList<Stripe.Checkout.Session>>);
  });

  afterEach(() => {
    listCheckoutSessionsSpy?.mockRestore();
  });

  test('both organizationId and kiloUserId: processes organization top-up; uses kiloUserId', async () => {
    const user = await insertTestUser();
    const org = await createOrganization('Org-Both', user.id);
    const amountInCents = 2300;
    const piId = `pi_both_${Math.random()}`;
    const chId = `ch_both_${Math.random()}`;

    const charge = makeCharge({ id: chId, amount: amountInCents, customer: 'cus_irrelevant' });
    const paymentIntent = makePaymentIntent({
      id: piId,
      metadata: withTopUpPrincipalMetadata(
        { organizationId: org.id, kiloUserId: user.id },
        amountInCents
      ),
    });

    await handleSuccessfulChargeWithPayment(charge, paymentIntent);

    const updatedOrg = await db.query.organizations.findFirst({
      where: eq(organizations.id, org.id),
    });
    const expectedIncrease = amountInCents * 10_000;
    const orgComputedBalance = org.total_microdollars_acquired - org.microdollars_used;
    const updatedComputedBalance =
      (updatedOrg?.total_microdollars_acquired ?? 0) - (updatedOrg?.microdollars_used ?? 0);
    expect(updatedComputedBalance).toBe(orgComputedBalance + expectedIncrease);

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

  test('org-auto-topup-setup processes initial organization top-up as auto with payment intent receipt id', async () => {
    const user = await insertTestUser();
    const org = await createOrganization('Org Auto Setup Initial Topup', user.id);
    const amountInCents = 1500;
    const paymentIntentId = `pi_org_auto_setup_initial_${Math.random()}`;
    const chargeId = `ch_org_auto_setup_initial_${Math.random()}`;

    const charge = makeCharge({
      id: chargeId,
      amount: amountInCents,
      customer: user.stripe_customer_id,
    });
    const paymentIntent = makePaymentIntent({
      id: paymentIntentId,
      metadata: withTopUpPrincipalMetadata(
        {
          type: 'org-auto-topup-setup',
          kiloUserId: user.id,
          organizationId: org.id,
        },
        amountInCents
      ),
    });

    const processOrgTopUpMock = processTopupForOrganization as jest.MockedFunction<
      typeof processTopupForOrganization
    >;
    processOrgTopUpMock.mockResolvedValueOnce(undefined);

    await handleSuccessfulChargeWithPayment(charge, paymentIntent);

    expect(processOrgTopUpMock).toHaveBeenCalledWith(
      user.id,
      org.id,
      amountInCents,
      { type: 'stripe', stripe_payment_id: paymentIntentId },
      { isAutoTopUp: true, serviceFeeCents: 0, grossPaidCents: amountInCents }
    );
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
      metadata: withTopUpPrincipalMetadata(
        { kiloUserId: user.id, type: 'stripe-checkout-topup' },
        amountInCents
      ),
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
    expect(updatedUser?.total_microdollars_acquired).toBe(amountInCents * 10_000);
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
        serviceFeePrincipalMinor: '2000',
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
        serviceFeePrincipalMinor: '5000',
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
        serviceFeePrincipalMinor: '2000',
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
          serviceFeePrincipalMinor: '5000',
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

  test('org-auto-topup-setup: created_by_user_id is persisted', async () => {
    await cleanupDbForTest();

    const user = await insertTestUser();
    const org = await createOrganization('Org CreatedBy Test', user.id);

    const { client } = await import('@/lib/stripe-client');
    const stripePaymentMethod = sampleStripePaymentMethod();

    const stripePaymentMethodResponse = {
      ...stripePaymentMethod,
      lastResponse: {
        headers: {},
        requestId: 'req_test_created_by',
        statusCode: 200,
      },
    } satisfies Stripe.Response<Stripe.PaymentMethod>;

    const retrieveSpy = jest
      .spyOn(client.paymentMethods, 'retrieve')
      .mockResolvedValue(stripePaymentMethodResponse);

    const charge = makeCharge({
      id: `ch_org_created_by_${Math.random()}`,
      amount: 1500,
      customer: user.stripe_customer_id,
    });

    const paymentIntent: Stripe.PaymentIntent = {
      id: `pi_org_created_by_${Math.random()}`,
      object: 'payment_intent',
      status: 'succeeded',
      payment_method: `pm_org_created_by_${Math.random()}`,
      metadata: {
        type: 'org-auto-topup-setup',
        kiloUserId: user.id,
        organizationId: org.id,
        amountCents: '3000',
        serviceFeePrincipalMinor: '3000',
      },
    } as unknown as Stripe.PaymentIntent;

    try {
      await handleSuccessfulChargeWithPayment(charge, paymentIntent);

      const config = await db.query.auto_top_up_configs.findFirst({
        where: eq(auto_top_up_configs.owned_by_organization_id, org.id),
      });

      expect(config).toBeTruthy();
      expect(config?.created_by_user_id).toBe(user.id);
    } finally {
      retrieveSpy.mockRestore();
    }
  });

  test('invoice.paid releases attempt_started_at lock when processTopUp throws', async () => {
    await cleanupDbForTest();

    const user = await insertTestUser();
    const userChargeId = `ch_user_lock_release_${Math.random()}`;

    await db.insert(auto_top_up_configs).values({
      owned_by_user_id: user.id,
      stripe_payment_method_id: `pm_lock_user_${Math.random()}`,
      amount_cents: 2000,
      attempt_started_at: new Date().toISOString(),
    });

    const processTopUpMock = processTopUp as jest.MockedFunction<typeof processTopUp>;
    processTopUpMock.mockRejectedValue(new Error('processTopUp test error'));

    const userInvoiceEvent: Stripe.Event = {
      ...baseStripeEvent(),
      type: 'invoice.paid',
      data: {
        object: {
          id: `in_user_lock_${Math.random()}`,
          object: 'invoice',
          charge: userChargeId,
          amount_paid: 5000,
          created: SERVICE_FEE_ACTIVATION_UNIX_SECONDS - 1,
          metadata: {
            type: 'auto-topup',
            kiloUserId: user.id,
            amountCents: '5000',
            serviceFeePrincipalMinor: '5000',
          },
        } as unknown as Stripe.Invoice,
        previous_attributes: {},
      },
    };

    try {
      await expect(processStripePaymentEventHook(userInvoiceEvent)).rejects.toThrow(
        'processTopUp test error'
      );

      const userConfig = await db.query.auto_top_up_configs.findFirst({
        where: eq(auto_top_up_configs.owned_by_user_id, user.id),
      });
      expect(userConfig?.attempt_started_at).toBeNull();
    } finally {
      processTopUpMock.mockRestore();
    }
  });

  test('invoice.paid releases attempt_started_at lock when processTopupForOrganization throws', async () => {
    await cleanupDbForTest();

    const orgUser = await insertTestUser();
    const org = await createOrganization('Org Lock Release Test', orgUser.id);
    const orgChargeId = `ch_org_lock_release_${Math.random()}`;

    await db.insert(auto_top_up_configs).values({
      owned_by_organization_id: org.id,
      stripe_payment_method_id: `pm_lock_org_${Math.random()}`,
      amount_cents: 2000,
      attempt_started_at: new Date().toISOString(),
      created_by_user_id: orgUser.id,
    });

    const processOrgTopUpMock = processTopupForOrganization as jest.MockedFunction<
      typeof processTopupForOrganization
    >;
    processOrgTopUpMock.mockRejectedValue(new Error('processTopupForOrganization test error'));

    const orgInvoiceEvent: Stripe.Event = {
      ...baseStripeEvent(),
      type: 'invoice.paid',
      data: {
        object: {
          id: `in_org_lock_${Math.random()}`,
          object: 'invoice',
          charge: orgChargeId,
          amount_paid: 5000,
          created: SERVICE_FEE_ACTIVATION_UNIX_SECONDS - 1,
          metadata: {
            type: 'org-auto-topup',
            organizationId: org.id,
            amountCents: '5000',
            serviceFeePrincipalMinor: '5000',
          },
        } as unknown as Stripe.Invoice,
        previous_attributes: {},
      },
    };

    try {
      await expect(processStripePaymentEventHook(orgInvoiceEvent)).rejects.toThrow(
        'processTopupForOrganization test error'
      );

      const orgConfig = await db.query.auto_top_up_configs.findFirst({
        where: eq(auto_top_up_configs.owned_by_organization_id, org.id),
      });
      expect(orgConfig?.attempt_started_at).toBeNull();
    } finally {
      processOrgTopUpMock.mockRestore();
    }
  });

  test('invoice.paid passes auto top-up option for organization auto top-ups', async () => {
    await cleanupDbForTest();

    const orgUser = await insertTestUser();
    const org = await createOrganization('Org Auto Email Variant Test', orgUser.id);
    const orgChargeId = `ch_org_auto_variant_${Math.random()}`;

    await db.insert(auto_top_up_configs).values({
      owned_by_organization_id: org.id,
      stripe_payment_method_id: `pm_auto_variant_${Math.random()}`,
      amount_cents: 2000,
      attempt_started_at: new Date().toISOString(),
      created_by_user_id: orgUser.id,
    });

    const processOrgTopUpMock = processTopupForOrganization as jest.MockedFunction<
      typeof processTopupForOrganization
    >;
    processOrgTopUpMock.mockResolvedValueOnce(undefined);

    const orgInvoiceEvent: Stripe.Event = {
      ...baseStripeEvent(),
      type: 'invoice.paid',
      data: {
        object: {
          id: `in_org_auto_variant_${Math.random()}`,
          object: 'invoice',
          charge: orgChargeId,
          amount_paid: 5000,
          created: SERVICE_FEE_ACTIVATION_UNIX_SECONDS - 1,
          metadata: {
            type: 'org-auto-topup',
            organizationId: org.id,
            amountCents: '5000',
            serviceFeePrincipalMinor: '5000',
          },
        } as unknown as Stripe.Invoice,
        previous_attributes: {},
      },
    };

    try {
      await processStripePaymentEventHook(orgInvoiceEvent);

      expect(processOrgTopUpMock).toHaveBeenCalledWith(
        orgUser.id,
        org.id,
        5000,
        { type: 'stripe', stripe_payment_id: orgChargeId },
        { isAutoTopUp: true, serviceFeeCents: 0, grossPaidCents: 5000 }
      );
    } finally {
      processOrgTopUpMock.mockRestore();
    }
  });

  test('credits trusted principal, not gross charge or invoice amount', async () => {
    await cleanupDbForTest();

    const user = await insertTestUser();
    const org = await createOrganization('Org Principal Vs Gross', user.id);
    const principalMinor = 10_000;
    const grossPaidMinor = 10_500;
    const paymentIntentId = `pi_principal_${Math.random()}`;
    const chargeId = `ch_principal_${Math.random()}`;

    const processOrgTopUpMock = processTopupForOrganization as jest.MockedFunction<
      typeof processTopupForOrganization
    >;
    processOrgTopUpMock.mockResolvedValueOnce(undefined);

    try {
      await handleSuccessfulChargeWithPayment(
        makeCharge({ id: chargeId, amount: grossPaidMinor, customer: user.stripe_customer_id }),
        makePaymentIntent({
          id: paymentIntentId,
          metadata: withTopUpPrincipalMetadata(
            {
              type: 'stripe-checkout-topup',
              kiloUserId: user.id,
              organizationId: org.id,
            },
            principalMinor
          ),
        })
      );

      expect(processOrgTopUpMock).toHaveBeenCalledWith(
        user.id,
        org.id,
        principalMinor,
        { type: 'stripe', stripe_payment_id: paymentIntentId },
        { isAutoTopUp: false, serviceFeeCents: 0, grossPaidCents: grossPaidMinor }
      );
    } finally {
      processOrgTopUpMock.mockRestore();
    }

    const processTopUpMock = processTopUp as jest.MockedFunction<typeof processTopUp>;
    processTopUpMock.mockResolvedValueOnce(true);
    const invoiceChargeId = `ch_invoice_principal_${Math.random()}`;
    await db.insert(auto_top_up_configs).values({
      owned_by_user_id: user.id,
      stripe_payment_method_id: `pm_principal_${Math.random()}`,
      amount_cents: principalMinor,
      attempt_started_at: new Date().toISOString(),
    });

    try {
      await processStripePaymentEventHook({
        ...baseStripeEvent(),
        type: 'invoice.paid',
        data: {
          object: {
            id: `in_principal_${Math.random()}`,
            object: 'invoice',
            charge: invoiceChargeId,
            amount_paid: grossPaidMinor,
            created: SERVICE_FEE_ACTIVATION_UNIX_SECONDS,
            metadata: {
              type: 'auto-topup',
              kiloUserId: user.id,
              amountCents: String(principalMinor),
              serviceFeePrincipalMinor: String(principalMinor),
            },
          } as unknown as Stripe.Invoice,
          previous_attributes: {},
        },
      });

      expect(processTopUpMock).toHaveBeenCalledWith(
        expect.objectContaining({ id: user.id }),
        principalMinor,
        { type: 'stripe', stripe_payment_id: invoiceChargeId },
        { isAutoTopUp: true, serviceFeeCents: 0, grossPaidCents: grossPaidMinor }
      );
    } finally {
      processTopUpMock.mockRestore();
    }
  });

  test('invoice.created skips kilo-owned auto-top-up invoices and leaves seats/KiloClaw fee-free', async () => {
    const { client } = await import('@/lib/stripe-client');
    const createInvoiceItem = jest.spyOn(client.invoiceItems, 'create');

    try {
      await processStripePaymentEventHook({
        ...baseStripeEvent(),
        type: 'invoice.created',
        data: {
          object: {
            id: 'in_auto_skip',
            object: 'invoice',
            created: SERVICE_FEE_ACTIVATION_UNIX_SECONDS,
            metadata: { type: 'auto-topup', kiloUserId: 'user_skip' },
          } as unknown as Stripe.Invoice,
          previous_attributes: {},
        },
      });
      await processStripePaymentEventHook({
        ...baseStripeEvent(),
        type: 'invoice.created',
        data: {
          object: {
            id: 'in_org_auto_skip',
            object: 'invoice',
            created: SERVICE_FEE_ACTIVATION_UNIX_SECONDS,
            metadata: { type: 'org-auto-topup', organizationId: 'org_skip' },
          } as unknown as Stripe.Invoice,
          previous_attributes: {},
        },
      });
      await processStripePaymentEventHook({
        ...baseStripeEvent(),
        type: 'invoice.created',
        data: {
          object: {
            id: 'in_seat_created',
            object: 'invoice',
            created: SERVICE_FEE_ACTIVATION_UNIX_SECONDS,
            metadata: { type: 'seats' },
            lines: {
              data: [
                {
                  pricing: { price_details: { price: process.env.STRIPE_TEAMS_MONTHLY_PRICE_ID } },
                },
              ],
            },
          } as unknown as Stripe.Invoice,
          previous_attributes: {},
        },
      });
      await processStripePaymentEventHook({
        ...baseStripeEvent(),
        type: 'invoice.created',
        data: {
          object: {
            id: 'in_kiloclaw_created',
            object: 'invoice',
            created: SERVICE_FEE_ACTIVATION_UNIX_SECONDS,
            lines: {
              data: [
                {
                  pricing: {
                    price_details: {
                      price: process.env.STRIPE_KILOCLAW_2026_05_10_STANDARD_PRICE_ID,
                    },
                  },
                },
              ],
            },
          } as unknown as Stripe.Invoice,
          previous_attributes: {},
        },
      });

      expect(createInvoiceItem).not.toHaveBeenCalled();
    } finally {
      createInvoiceItem.mockRestore();
    }
  });

  test('invoice.created assesses an eligible personal Kilo Pass draft without attaching a second auto-top-up fee', async () => {
    await cleanupDbForTest();
    const user = await insertTestUser();
    const { client } = await import('@/lib/stripe-client');
    const createInvoiceItem = jest.spyOn(client.invoiceItems, 'create').mockResolvedValue({
      id: 'ii_kilo_pass_fee',
      amount: 245,
    } as unknown as Stripe.Response<Stripe.InvoiceItem>);
    const retrievePrice = jest.spyOn(client.prices, 'retrieve').mockResolvedValue({
      id: CURRENT_KILO_PASS_TIER_19_MONTHLY_PRICE_ID,
      tax_behavior: 'exclusive',
    } as unknown as Stripe.Response<Stripe.Price>);
    const invoiceId = `in_kilo_pass_created_${Math.random().toString(36).slice(2)}`;
    const metadata = {
      type: 'kilo-pass',
      kiloUserId: user.id,
      tier: KiloPassTier.Tier49,
      cadence: KiloPassCadence.Monthly,
    };

    try {
      await processStripePaymentEventHook({
        ...baseStripeEvent(),
        type: 'invoice.created',
        data: {
          object: {
            id: invoiceId,
            object: 'invoice',
            status: 'draft',
            created: SERVICE_FEE_ACTIVATION_UNIX_SECONDS,
            currency: 'usd',
            customer: user.stripe_customer_id,
            metadata,
            parent: {
              type: 'subscription_details',
              quote_details: null,
              subscription_details: {
                metadata,
                subscription: {
                  id: 'sub_kilo_pass_created',
                  object: 'subscription',
                  metadata,
                  items: {
                    object: 'list',
                    data: [],
                    has_more: false,
                    url: '/v1/subscription_items',
                  },
                },
              },
            },
            lines: {
              object: 'list',
              has_more: false,
              url: `/v1/invoices/${invoiceId}/lines`,
              data: [
                {
                  id: 'il_kilo_pass_created',
                  object: 'line_item',
                  amount: 4_900,
                  currency: 'usd',
                  description: 'Kilo Pass',
                  discountable: true,
                  discount_amounts: null,
                  discounts: [],
                  invoice: invoiceId,
                  livemode: false,
                  metadata,
                  parent: null,
                  period: { start: 1, end: 2 },
                  pretax_credit_amounts: null,
                  pricing: {
                    type: 'price_details',
                    unit_amount_decimal: '4900',
                    price_details: {
                      price: CURRENT_KILO_PASS_TIER_19_MONTHLY_PRICE_ID,
                      product: 'prod_kilo_pass',
                    },
                  },
                  quantity: 1,
                  subscription: null,
                  taxes: null,
                },
              ],
            },
          } as unknown as Stripe.Invoice,
          previous_attributes: {},
        },
      });

      const [assessment] = await db
        .select()
        .from(stripe_service_fee_assessments)
        .where(eq(stripe_service_fee_assessments.stripe_invoice_id, invoiceId))
        .limit(1);
      expect(assessment).toMatchObject({
        flow: 'personal_kilo_pass',
        kilo_user_id: user.id,
        eligible_subtotal_minor: 4_900,
        expected_fee_minor: 245,
      });
      expect(assessment?.outcome === 'charged' || assessment?.outcome === 'missed').toBe(true);
      if (assessment?.outcome === 'missed') {
        expect(createInvoiceItem).not.toHaveBeenCalled();
      } else {
        expect(createInvoiceItem).toHaveBeenCalledTimes(1);
      }
    } finally {
      retrievePrice.mockRestore();
      createInvoiceItem.mockRestore();
    }
  });

  test('invoice.created fee attachment failure is acknowledged', async () => {
    const handleKiloPassInvoiceCreated = jest.fn(async (_params: { invoice: Stripe.Invoice }) => {
      throw new Error('fee attachment failed');
    });
    const invoice = {
      id: 'in_kilo_pass_attach_fail',
      object: 'invoice',
      status: 'draft',
      created: SERVICE_FEE_ACTIVATION_UNIX_SECONDS,
      currency: 'usd',
      customer: 'cus_attach_fail',
      metadata: {
        type: 'kilo-pass',
        kiloUserId: 'user_kilo_pass_attach_fail',
        tier: KiloPassTier.Tier49,
        cadence: KiloPassCadence.Monthly,
      },
      lines: {
        object: 'list',
        has_more: false,
        data: [
          {
            pricing: {
              price_details: { price: CURRENT_KILO_PASS_TIER_19_MONTHLY_PRICE_ID },
            },
            amount: 4_900,
          },
        ],
      },
    } as unknown as Stripe.Invoice;

    try {
      jest.resetModules();
      jest.doMock('@/lib/service-fees/invoice-created', () => {
        const actual = jest.requireActual('@/lib/service-fees/invoice-created');
        return {
          __esModule: true,
          ...actual,
          handleKiloPassInvoiceCreated,
        };
      });

      await jest.isolateModulesAsync(async () => {
        const { processStripePaymentEventHook: dispatch } = await import('@/lib/stripe');
        await expect(
          dispatch({
            ...baseStripeEvent(),
            type: 'invoice.created',
            data: { object: invoice, previous_attributes: {} },
          } as Stripe.Event)
        ).resolves.toBeUndefined();
      });

      expect(handleKiloPassInvoiceCreated).toHaveBeenCalledWith(
        expect.objectContaining({ invoice })
      );
    } finally {
      jest.dontMock('@/lib/service-fees/invoice-created');
      jest.resetModules();
    }
  });

  test('invoice.paid dispatches zero-dollar KiloClaw invoices to settlement', async () => {
    const handleKiloClawInvoicePaid = jest.fn<
      Promise<void>,
      [{ eventId: string; invoice: Stripe.Invoice }]
    >();
    handleKiloClawInvoicePaid.mockResolvedValue(undefined);

    const event: Stripe.Event = {
      ...baseStripeEvent(),
      id: 'evt_zero_invoice_dispatch',
      type: 'invoice.paid',
      data: {
        object: {
          id: 'in_zero_invoice_dispatch',
          object: 'invoice',
          amount_paid: 0,
          charge: null,
          currency: 'usd',
          parent: {
            subscription_details: {
              subscription: 'sub_zero_invoice_dispatch',
            },
          },
          lines: {
            data: [
              {
                pricing: {
                  price_details: {
                    price: process.env.STRIPE_KILOCLAW_2026_03_19_STANDARD_PRICE_ID,
                  },
                },
                period: {
                  start: Math.floor(new Date('2026-04-01T00:00:00.000Z').getTime() / 1000),
                  end: Math.floor(new Date('2026-05-01T00:00:00.000Z').getTime() / 1000),
                },
              },
            ],
          },
        } as unknown as Stripe.Invoice,
        previous_attributes: {},
      },
    };

    try {
      jest.resetModules();
      jest.doMock('@/lib/kiloclaw/stripe-handlers', () => {
        const actual = jest.requireActual<typeof kiloclawStripeHandlersModule>(
          '@/lib/kiloclaw/stripe-handlers'
        );
        return {
          __esModule: true,
          ...actual,
          handleKiloClawInvoicePaid,
        };
      });

      await jest.isolateModulesAsync(async () => {
        const { processStripePaymentEventHook: isolatedProcessStripePaymentEventHook } =
          await import('@/lib/stripe');
        await isolatedProcessStripePaymentEventHook(event);
      });

      expect(handleKiloClawInvoicePaid).toHaveBeenCalledWith({
        eventId: 'evt_zero_invoice_dispatch',
        invoice: event.data.object,
      });
    } finally {
      jest.dontMock('@/lib/kiloclaw/stripe-handlers');
      jest.resetModules();
    }
  });

  test('invoice.paid dispatches metadata-resolved Kilo Pass invoices without price SKU lines', async () => {
    const handleKiloPassInvoicePaid = jest.fn<
      Promise<void>,
      [{ eventId: string; invoice: Stripe.Invoice; stripe: Stripe }]
    >();
    handleKiloPassInvoicePaid.mockResolvedValue(undefined);

    const event: Stripe.Event = {
      ...baseStripeEvent(),
      id: 'evt_kilo_pass_metadata_dispatch',
      type: 'invoice.paid',
      data: {
        object: {
          id: 'in_kilo_pass_metadata_dispatch',
          object: 'invoice',
          amount_paid: 1900,
          currency: 'usd',
          parent: {
            subscription_details: {
              subscription: 'sub_kilo_pass_metadata_dispatch',
              metadata: {
                type: 'kilo-pass',
                kiloUserId: 'user_kilo_pass_metadata_dispatch',
                tier: KiloPassTier.Tier19,
                cadence: KiloPassCadence.Monthly,
              },
            },
          },
          lines: {
            data: [],
          },
        } as unknown as Stripe.Invoice,
        previous_attributes: {},
      },
    };

    try {
      jest.resetModules();
      jest.doMock('@/lib/kilo-pass/stripe-handlers', () => {
        const actual = jest.requireActual<typeof kiloPassStripeHandlersModule>(
          '@/lib/kilo-pass/stripe-handlers'
        );
        return {
          __esModule: true,
          ...actual,
          handleKiloPassInvoicePaid,
        };
      });

      await jest.isolateModulesAsync(async () => {
        const { processStripePaymentEventHook: isolatedProcessStripePaymentEventHook } =
          await import('@/lib/stripe');
        await isolatedProcessStripePaymentEventHook(event);
      });

      expect(handleKiloPassInvoicePaid).toHaveBeenCalledWith(
        expect.objectContaining({
          eventId: 'evt_kilo_pass_metadata_dispatch',
          invoice: event.data.object,
        })
      );
    } finally {
      jest.dontMock('@/lib/kilo-pass/stripe-handlers');
      jest.resetModules();
    }
  });

  test('routes an organization Kilo Pass invoice before the personal Kilo Pass handler', async () => {
    const handleOrganizationKiloPassInvoicePaid = jest.fn().mockResolvedValue(undefined);
    const handleKiloPassInvoicePaid = jest.fn().mockResolvedValue(undefined);
    const event = {
      ...baseStripeEvent(),
      id: 'evt_org_kilo_pass_first',
      type: 'invoice.paid',
      data: {
        object: {
          id: 'in_org_kilo_pass_first',
          object: 'invoice',
          parent: {
            subscription_details: {
              subscription: 'sub_org_kilo_pass_first',
              metadata: {
                type: 'kilo-pass-org',
                organizationId: 'org_1',
                kiloUserId: 'user_1',
                tier: 'tier_19',
                cadence: 'monthly',
              },
            },
          },
          lines: {
            data: [
              { pricing: { price_details: { price: CURRENT_KILO_PASS_TIER_19_MONTHLY_PRICE_ID } } },
            ],
          },
        } as unknown as Stripe.Invoice,
        previous_attributes: {},
      },
    } as Stripe.Event;

    try {
      jest.resetModules();
      jest.doMock('@/lib/kilo-pass-org/stripe-adapter', () => ({
        endPendingOrganizationKiloPassForTerminalInvoice: jest.fn(),
        handleOrganizationKiloPassInvoicePaid,
        handleOrganizationKiloPassPaymentAdverseForInvoice: jest.fn(),
        handleOrganizationKiloPassSubscriptionEvent: jest.fn(),
      }));
      jest.doMock('@/lib/kilo-pass/stripe-handlers', () => {
        const actual = jest.requireActual<typeof kiloPassStripeHandlersModule>(
          '@/lib/kilo-pass/stripe-handlers'
        );
        return { __esModule: true, ...actual, handleKiloPassInvoicePaid };
      });

      await jest.isolateModulesAsync(async () => {
        const { processStripePaymentEventHook: isolatedProcessStripePaymentEventHook } =
          await import('@/lib/stripe');
        await isolatedProcessStripePaymentEventHook(event);
      });

      expect(handleOrganizationKiloPassInvoicePaid).toHaveBeenCalledWith({
        invoice: event.data.object,
      });
      expect(handleKiloPassInvoicePaid).not.toHaveBeenCalled();
    } finally {
      jest.dontMock('@/lib/kilo-pass-org/stripe-adapter');
      jest.dontMock('@/lib/kilo-pass/stripe-handlers');
      jest.resetModules();
    }
  });

  test.each(['invoice.voided', 'invoice.marked_uncollectible'] as const)(
    'ends a pending organization checkout for terminal event %s',
    async type => {
      const endPendingOrganizationKiloPassForTerminalInvoice = jest.fn().mockResolvedValue(true);
      const invoice = {
        id: 'in_org_terminal',
        object: 'invoice',
        parent: {
          subscription_details: {
            subscription: 'sub_org_terminal',
            metadata: {
              type: 'kilo-pass-org',
              organizationId: 'org_1',
              kiloUserId: 'user_1',
              tier: 'tier_19',
              cadence: 'monthly',
            },
          },
        },
        lines: { data: [] },
      } as unknown as Stripe.Invoice;
      try {
        jest.resetModules();
        jest.doMock('@/lib/kilo-pass-org/stripe-adapter', () => ({
          endPendingOrganizationKiloPassForTerminalInvoice,
          handleOrganizationKiloPassInvoicePaid: jest.fn(),
          handleOrganizationKiloPassPaymentAdverseForInvoice: jest.fn(),
          handleOrganizationKiloPassSubscriptionEvent: jest.fn(),
        }));
        await jest.isolateModulesAsync(async () => {
          const { processStripePaymentEventHook: dispatch } = await import('@/lib/stripe');
          await dispatch({
            ...baseStripeEvent(),
            type,
            data: { object: invoice, previous_attributes: {} },
          } as Stripe.Event);
        });
        expect(endPendingOrganizationKiloPassForTerminalInvoice).toHaveBeenCalledWith(invoice);
      } finally {
        jest.dontMock('@/lib/kilo-pass-org/stripe-adapter');
        jest.resetModules();
      }
    }
  );

  test.each([
    'customer.subscription.created',
    'customer.subscription.updated',
    'customer.subscription.deleted',
  ] as const)(
    'dispatches %s organization lifecycle events to the organization adapter',
    async type => {
      const handleOrganizationKiloPassSubscriptionEvent = jest.fn().mockResolvedValue(undefined);
      const subscription = {
        id: 'sub_org_lifecycle_dispatch',
        metadata: { type: 'kilo-pass-org' },
      } as unknown as Stripe.Subscription;
      try {
        jest.resetModules();
        jest.doMock('@/lib/kilo-pass-org/stripe-adapter', () => ({
          endPendingOrganizationKiloPassForTerminalInvoice: jest.fn(),
          handleOrganizationKiloPassInvoicePaid: jest.fn(),
          handleOrganizationKiloPassPaymentAdverseForInvoice: jest.fn(),
          handleOrganizationKiloPassSubscriptionEvent,
        }));
        jest.doMock('@/lib/organizations/organization-seats', () => ({
          handleSubscriptionEvent: jest.fn().mockResolvedValue(undefined),
        }));
        await jest.isolateModulesAsync(async () => {
          const { processStripePaymentEventHook: dispatch } = await import('@/lib/stripe');
          await dispatch({
            ...baseStripeEvent(),
            type,
            data: { object: subscription, previous_attributes: {} },
          } as Stripe.Event);
        });
        expect(handleOrganizationKiloPassSubscriptionEvent).toHaveBeenCalledWith(subscription);
      } finally {
        jest.dontMock('@/lib/kilo-pass-org/stripe-adapter');
        jest.dontMock('@/lib/organizations/organization-seats');
        jest.resetModules();
      }
    }
  );

  test.each([
    ['charge.refunded', { id: 'ch_org_adverse', amount_refunded: 1900 }],
    [
      'charge.dispute.created',
      {
        id: 'dp_org_adverse',
        charge: 'ch_org_adverse',
        amount: 1900,
        currency: 'usd',
        created: 1_767_225_600,
      },
    ],
  ] as const)(
    'suspends organization agreements for %s without affiliate context',
    async (type, object) => {
      const handleOrganizationKiloPassPaymentAdverseForInvoice = jest
        .fn()
        .mockResolvedValue(undefined);
      const invoice = {
        id: 'in_org_adverse',
        object: 'invoice',
        parent: {
          subscription_details: {
            metadata: {
              type: 'kilo-pass-org',
              organizationId: 'org_1',
              kiloUserId: 'user_1',
              tier: 'tier_19',
              cadence: 'monthly',
            },
          },
        },
        lines: { data: [] },
      } as unknown as Stripe.Invoice;
      try {
        jest.resetModules();
        jest.doMock('@/lib/kilo-pass-org/stripe-adapter', () => ({
          endPendingOrganizationKiloPassForTerminalInvoice: jest.fn(),
          handleOrganizationKiloPassInvoicePaid: jest.fn(),
          handleOrganizationKiloPassPaymentAdverseForInvoice,
          handleOrganizationKiloPassSubscriptionEvent: jest.fn(),
        }));
        jest.doMock('@/lib/stripe-client', () => ({
          client: {
            charges: {
              retrieve: jest.fn().mockResolvedValue({
                id: 'ch_org_adverse',
                invoice,
              }),
            },
            invoices: { retrieve: jest.fn().mockResolvedValue(invoice) },
          },
        }));
        await jest.isolateModulesAsync(async () => {
          const { processStripePaymentEventHook: dispatch } = await import('@/lib/stripe');
          await dispatch({
            ...baseStripeEvent(),
            type,
            data: { object, previous_attributes: {} },
          } as Stripe.Event);
        });
        expect(handleOrganizationKiloPassPaymentAdverseForInvoice).toHaveBeenCalledWith(invoice);
      } finally {
        jest.dontMock('@/lib/kilo-pass-org/stripe-adapter');
        jest.dontMock('@/lib/stripe-client');
        jest.resetModules();
      }
    }
  );
});

function createMemoryAssessmentStore(): ServiceFeeAssessmentStore {
  const rows = new Map<string, ServiceFeeAssessmentRecord>();
  const store: ServiceFeeAssessmentStore = {
    async transact(fn) {
      return fn(store);
    },
    async findByAssessmentKey(assessmentKey) {
      const row = rows.get(assessmentKey);
      return row ? { ...row, metadata: { ...row.metadata } } : null;
    },
    async insert(record) {
      if (rows.has(record.assessmentKey)) {
        throw new Error(`duplicate assessment_key ${record.assessmentKey}`);
      }
      const copy = { ...record, metadata: { ...record.metadata } };
      rows.set(record.assessmentKey, copy);
      return { ...copy };
    },
    async update(assessmentKey, patch) {
      const existing = rows.get(assessmentKey);
      if (!existing) throw new Error(`missing ${assessmentKey}`);
      const next = {
        ...existing,
        ...patch,
        metadata: { ...existing.metadata, ...(patch.metadata ?? {}) },
      };
      rows.set(assessmentKey, next);
      return { ...next };
    },
  };
  return Object.assign(store, {
    async findByStripeInvoiceId(stripeInvoiceId: string) {
      const row = [...rows.values()].find(
        candidate => candidate.stripeInvoiceId === stripeInvoiceId
      );
      return row ? { ...row, metadata: { ...row.metadata } } : null;
    },
  });
}

describe('handleUpdateSeatCount organization Kilo Pass service fee', () => {
  const subscriptionId = 'sub_seat_capacity_fee';
  const seatItemId = 'si_seat_paid';
  const passItemId = 'si_pass';
  const seatPriceId = 'price_test_seat_capacity';
  const prorationDate = SERVICE_FEE_ACTIVATION_UNIX_SECONDS;
  const now = new Date(prorationDate * 1000);
  const seatProductId = [...SEAT_PRODUCT_IDS][0] ?? 'prod_seat';
  let actor: User;
  let organizationId: string;

  function memoryStore() {
    return createMemoryAssessmentStore();
  }

  function invoiceLine(params: {
    id: string;
    amount: number;
    priceId: string;
    productId: string;
    subscriptionItem: string;
  }): Stripe.InvoiceLineItem {
    return {
      id: params.id,
      object: 'line_item',
      amount: params.amount,
      currency: 'usd',
      description: params.subscriptionItem,
      discountable: true,
      discount_amounts: null,
      discounts: [],
      invoice: 'in_preview',
      livemode: false,
      metadata: {},
      parent: {
        type: 'subscription_item_details',
        invoice_item_details: null,
        subscription_item_details: {
          invoice_item: null,
          proration: true,
          proration_details: { credited_items: null },
          subscription: subscriptionId,
          subscription_item: params.subscriptionItem,
        },
      },
      period: { start: prorationDate, end: prorationDate + 86_400 },
      pretax_credit_amounts: null,
      pricing: {
        type: 'price_details',
        unit_amount_decimal: String(params.amount),
        price_details: { price: params.priceId, product: params.productId },
      },
      quantity: 10,
      subscription: subscriptionId,
      taxes: null,
    } as Stripe.InvoiceLineItem;
  }

  function mixedLines() {
    return [
      invoiceLine({
        id: 'il_seat',
        amount: 8_000,
        priceId: seatPriceId,
        productId: seatProductId,
        subscriptionItem: seatItemId,
      }),
      invoiceLine({
        id: 'il_pass',
        amount: 3_000,
        priceId: CURRENT_KILO_PASS_TIER_19_MONTHLY_PRICE_ID,
        productId: 'prod_kilo_pass',
        subscriptionItem: passItemId,
      }),
    ];
  }

  function orgSubscription(overrides: Partial<Stripe.Subscription> = {}): Stripe.Subscription {
    return {
      id: subscriptionId,
      object: 'subscription',
      status: 'active',
      customer: 'cus_seat_capacity',
      metadata: {
        type: 'kilo-pass-org',
        organizationId,
        kiloUserId: actor.id,
        tier: 'tier_19',
        cadence: 'monthly',
        seats: '10',
      },
      items: {
        object: 'list',
        data: [
          {
            id: seatItemId,
            quantity: 5,
            current_period_start: prorationDate,
            current_period_end: prorationDate + 2_592_000,
            price: {
              id: seatPriceId,
              product: seatProductId,
              unit_amount: 2_900,
              recurring: { interval: 'month' },
            },
          },
          {
            id: passItemId,
            quantity: 5,
            current_period_start: prorationDate,
            current_period_end: prorationDate + 2_592_000,
            price: { id: CURRENT_KILO_PASS_TIER_19_MONTHLY_PRICE_ID, product: 'prod_kilo_pass' },
          },
        ],
        has_more: false,
        url: '/v1/subscription_items',
      },
      ...overrides,
    } as Stripe.Subscription;
  }

  function previewInvoice(lines = mixedLines()): Stripe.Invoice {
    return {
      id: 'in_preview',
      object: 'invoice',
      created: prorationDate,
      status: 'draft',
      currency: 'usd',
      customer: 'cus_seat_capacity',
      lines: {
        object: 'list',
        data: lines,
        has_more: false,
        url: '/v1/invoices/upcoming/lines',
      },
    } as Stripe.Invoice;
  }

  function draftInvoice(lines = mixedLines()): Stripe.Invoice {
    return {
      ...previewInvoice(lines),
      id: 'in_actual',
      status: 'draft',
    } as Stripe.Invoice;
  }

  beforeEach(async () => {
    KNOWN_SEAT_PRICE_IDS.add(seatPriceId);
    actor = await insertTestUser();
    const organization = await createOrganization(`Seat capacity fee ${Date.now()}`, actor.id);
    organizationId = organization.id;
  });

  afterEach(() => {
    KNOWN_SEAT_PRICE_IDS.delete(seatPriceId);
    jest.restoreAllMocks();
  });

  test('preview and update share proration_date and exclude seat amount', async () => {
    const store = memoryStore();
    const retrieve = jest
      .spyOn(client.subscriptions, 'retrieve')
      .mockResolvedValue(orgSubscription() as never);
    const createPreview = jest
      .spyOn(client.invoices, 'createPreview')
      .mockResolvedValue(previewInvoice() as never);
    const update = jest.spyOn(client.subscriptions, 'update').mockResolvedValue({
      ...orgSubscription(),
      latest_invoice: draftInvoice(),
    } as never);
    const createItem = jest.spyOn(client.invoiceItems, 'create').mockResolvedValue({
      id: 'ii_fee',
      amount: 150,
    } as never);
    const finalize = jest.spyOn(client.invoices, 'finalizeInvoice').mockResolvedValue({
      ...draftInvoice(),
      status: 'open',
    } as never);
    jest.spyOn(client.invoices, 'pay').mockResolvedValue({
      ...draftInvoice(),
      status: 'paid',
    } as never);

    await handleUpdateSeatCount(subscriptionId, 10, 5, {
      now,
      store,
      getOrganizationPurchaseChannel: async () => 'self_serve',
      resolveTaxInput: async () => ({
        source: 'price',
        taxBehavior: 'exclusive',
      }),
      sendAlert: async () => undefined,
    });

    expect(createPreview).toHaveBeenCalledWith(
      expect.objectContaining({
        subscription: subscriptionId,
        subscription_details: expect.objectContaining({
          proration_date: prorationDate,
          items: [
            { id: seatItemId, quantity: 10 },
            { id: passItemId, quantity: 10 },
          ],
        }),
      })
    );
    expect(update).toHaveBeenCalledWith(
      subscriptionId,
      expect.objectContaining({
        proration_date: prorationDate,
        proration_behavior: 'always_invoice',
      }),
      expect.any(Object)
    );
    expect(createItem).toHaveBeenCalledWith(
      expect.objectContaining({
        amount: 150,
        discountable: false,
      })
    );
    expect(createItem.mock.calls[0]?.[0]).not.toEqual(
      expect.objectContaining({ invoice: 'in_actual' })
    );
    expect(
      await store.findByAssessmentKey(
        kiloPassOrgStripe.createSeatCapacityServiceFeeAssessmentKey({
          subscriptionId,
          prorationDate,
          paidSeatQuantity: 10,
        })
      )
    ).toMatchObject({
      eligibleSubtotalMinor: 3_000,
      expectedFeeMinor: 150,
      chargedFeeMinor: 150,
      outcome: 'charged',
    });
    expect(retrieve).toHaveBeenCalled();
    expect(finalize).toHaveBeenCalled();
  });

  test('seat-only updates do not preview or persist an assessment', async () => {
    const store = memoryStore();
    const insert = jest.spyOn(store, 'insert');
    jest.spyOn(client.subscriptions, 'retrieve').mockResolvedValue({
      id: subscriptionId,
      object: 'subscription',
      status: 'active',
      metadata: {
        type: 'seats',
        kiloUserId: actor.id,
        organizationId,
        seats: '10',
      },
      items: {
        data: [
          {
            id: seatItemId,
            quantity: 5,
            current_period_start: prorationDate,
            current_period_end: prorationDate + 2_592_000,
            price: {
              id: seatPriceId,
              product: seatProductId,
              unit_amount: 2_900,
              recurring: { interval: 'month' },
            },
          },
        ],
      },
    } as never);
    const createPreview = jest.spyOn(client.invoices, 'createPreview');
    jest.spyOn(client.subscriptions, 'update').mockResolvedValue({
      id: subscriptionId,
      object: 'subscription',
      status: 'active',
      metadata: {
        type: 'seats',
        kiloUserId: actor.id,
        organizationId,
        seats: '10',
      },
      items: {
        data: [
          {
            id: seatItemId,
            quantity: 10,
            current_period_start: prorationDate,
            current_period_end: prorationDate + 2_592_000,
            price: {
              id: seatPriceId,
              product: seatProductId,
              unit_amount: 2_900,
              recurring: { interval: 'month' },
            },
          },
        ],
      },
    } as never);

    await expect(handleUpdateSeatCount(subscriptionId, 10, 5, { now, store })).resolves.toEqual(
      expect.objectContaining({ success: true })
    );
    expect(createPreview).not.toHaveBeenCalled();
    expect(insert).not.toHaveBeenCalled();
  });

  test('tax resolution failure fails open and still updates seats', async () => {
    const store = memoryStore();
    const sendAlert = jest.fn(async () => undefined);
    jest.spyOn(client.subscriptions, 'retrieve').mockResolvedValue(orgSubscription() as never);
    jest.spyOn(client.invoices, 'createPreview').mockResolvedValue(previewInvoice() as never);
    const update = jest.spyOn(client.subscriptions, 'update').mockResolvedValue({
      ...orgSubscription(),
      latest_invoice: { ...draftInvoice(), status: 'open' },
    } as never);
    const createItem = jest.spyOn(client.invoiceItems, 'create');
    jest.spyOn(client.invoices, 'pay').mockResolvedValue({
      ...draftInvoice(),
      status: 'paid',
    } as never);

    await expect(
      handleUpdateSeatCount(subscriptionId, 10, 5, {
        now,
        store,
        getOrganizationPurchaseChannel: async () => 'self_serve',
        resolveTaxInput: async () => {
          throw new Error('fee_application_failed');
        },
        sendAlert,
      })
    ).resolves.toEqual(expect.objectContaining({ success: true }));

    expect(update).toHaveBeenCalled();
    expect(createItem).not.toHaveBeenCalled();
    expect(
      await store.findByAssessmentKey(
        kiloPassOrgStripe.createSeatCapacityServiceFeeAssessmentKey({
          subscriptionId,
          prorationDate,
          paidSeatQuantity: 10,
        })
      )
    ).toMatchObject({
      outcome: 'missed',
      failureCode: 'fee_application_failed',
      expectedFeeMinor: 150,
    });
    expect(sendAlert).toHaveBeenCalled();
  });

  test('injected tax attaches the prepared fee before finalize', async () => {
    const store = memoryStore();
    const calls: string[] = [];
    jest.spyOn(client.subscriptions, 'retrieve').mockResolvedValue(orgSubscription() as never);
    jest.spyOn(client.invoices, 'createPreview').mockImplementation(async () => {
      calls.push('preview');
      return previewInvoice() as never;
    });
    jest.spyOn(client.subscriptions, 'update').mockImplementation(async () => {
      calls.push('update');
      return {
        ...orgSubscription(),
        latest_invoice: draftInvoice(),
      } as never;
    });
    jest.spyOn(client.invoiceItems, 'create').mockImplementation(async () => {
      calls.push('attach');
      return { id: 'ii_fee', amount: 150 } as never;
    });
    jest.spyOn(client.invoices, 'finalizeInvoice').mockImplementation(async () => {
      calls.push('finalize');
      return { ...draftInvoice(), status: 'open' } as never;
    });
    jest.spyOn(client.invoices, 'pay').mockImplementation(async () => {
      calls.push('pay');
      return { ...draftInvoice(), status: 'paid' } as never;
    });

    await handleUpdateSeatCount(subscriptionId, 10, 5, {
      now,
      store,
      getOrganizationPurchaseChannel: async () => 'self_serve',
      resolveTaxInput: async () => ({
        source: 'price',
        taxBehavior: 'exclusive',
      }),
      sendAlert: async () => undefined,
    });

    expect(calls).toEqual(['preview', 'attach', 'update', 'attach', 'finalize', 'pay']);
  });

  test('does not preview, look up tax/exemption, or write assessments after the advisory lock', async () => {
    const store = memoryStore();
    const calls: string[] = [];
    const originalTransaction = db.transaction.bind(db);
    jest.spyOn(db, 'transaction').mockImplementation(((...args: unknown[]) => {
      calls.push('transaction-start');
      const result = originalTransaction(...(args as Parameters<typeof db.transaction>));
      return Promise.resolve(result).then(value => {
        calls.push('transaction-end');
        return value;
      });
    }) as typeof db.transaction);
    const originalInsert = store.insert.bind(store);
    jest.spyOn(store, 'insert').mockImplementation(async record => {
      calls.push('assessment-insert');
      return originalInsert(record);
    });
    jest.spyOn(client.subscriptions, 'retrieve').mockResolvedValue(orgSubscription() as never);
    jest.spyOn(client.invoices, 'createPreview').mockImplementation(async () => {
      calls.push('preview');
      return previewInvoice() as never;
    });
    const resolveTaxInput = jest.fn(async () => {
      calls.push('tax');
      return {
        source: 'price' as const,
        taxBehavior: 'exclusive' as const,
      };
    });
    const findEffectiveExemption = jest.fn(async () => {
      calls.push('exemption');
      return null;
    });
    jest.spyOn(client.subscriptions, 'update').mockImplementation(async () => {
      calls.push('update');
      return {
        ...orgSubscription(),
        latest_invoice: draftInvoice(),
      } as never;
    });
    jest.spyOn(client.invoiceItems, 'create').mockImplementation(async () => {
      calls.push('attach');
      return { id: 'ii_fee', amount: 150 } as never;
    });
    jest.spyOn(client.invoices, 'finalizeInvoice').mockResolvedValue({
      ...draftInvoice(),
      status: 'open',
    } as never);
    jest.spyOn(client.invoices, 'pay').mockResolvedValue({
      ...draftInvoice(),
      status: 'paid',
    } as never);

    await handleUpdateSeatCount(subscriptionId, 10, 5, {
      now,
      store,
      getOrganizationPurchaseChannel: async () => 'self_serve',
      resolveTaxInput,
      findEffectiveExemption,
      sendAlert: async () => undefined,
    });

    const transactionStart = calls.indexOf('transaction-start');
    const transactionEnd = calls.indexOf('transaction-end');
    expect(transactionStart).toBeGreaterThan(-1);
    expect(transactionEnd).toBeGreaterThan(transactionStart);
    expect(calls.indexOf('preview')).toBeLessThan(transactionStart);
    expect(calls.indexOf('tax')).toBeLessThan(transactionStart);
    expect(calls.indexOf('exemption')).toBeLessThan(transactionStart);
    expect(calls.indexOf('assessment-insert')).toBeLessThan(transactionStart);
    expect(calls.indexOf('attach')).toBeLessThan(transactionStart);
    expect(calls.lastIndexOf('attach')).toBeGreaterThan(transactionEnd);
    expect(calls.slice(transactionStart, transactionEnd + 1)).not.toContain('preview');
    expect(calls.slice(transactionStart, transactionEnd + 1)).not.toContain('tax');
    expect(calls.slice(transactionStart, transactionEnd + 1)).not.toContain('exemption');
    expect(calls.slice(transactionStart, transactionEnd + 1)).not.toContain('assessment-insert');
    expect(calls.slice(transactionStart, transactionEnd + 1)).not.toContain('attach');
  });
});
