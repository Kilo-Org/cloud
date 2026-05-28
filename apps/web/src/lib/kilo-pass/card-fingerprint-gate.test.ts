import { beforeEach, describe, expect, jest, test } from '@jest/globals';

import { db, cleanupDbForTest } from '@/lib/drizzle';
import {
  credit_transactions,
  kilocode_users,
  kilo_pass_audit_log,
  kilo_pass_subscriptions,
  payment_methods,
  transactional_email_log,
} from '@kilocode/db/schema';
import { KiloPassAuditLogAction } from './enums';
import { KiloPassCadence } from './enums';
import { KiloPassTier } from '@/lib/kilo-pass/enums';
import { KiloPassPaymentProvider } from '@/lib/kilo-pass/enums';
import { insertTestUser } from '@/tests/helpers/user.helper';
import { and, eq } from 'drizzle-orm';
import type Stripe from 'stripe';
import { randomUUID } from 'node:crypto';

jest.mock('@/lib/email', () => ({
  sendKiloPassDuplicateCardCanceledEmail: jest.fn(async () => ({ sent: true })),
}));

function ensureKiloPassStripePriceIdEnv(): void {
  const env = process.env;
  env.STRIPE_KILO_PASS_TIER_19_MONTHLY_PRICE_ID ||= 'price_test_kilo_pass_tier_19_monthly';
  env.STRIPE_KILO_PASS_TIER_19_YEARLY_PRICE_ID ||= 'price_test_kilo_pass_tier_19_yearly';
  env.STRIPE_KILO_PASS_TIER_49_MONTHLY_PRICE_ID ||= 'price_test_kilo_pass_tier_49_monthly';
  env.STRIPE_KILO_PASS_TIER_49_YEARLY_PRICE_ID ||= 'price_test_kilo_pass_tier_49_yearly';
  env.STRIPE_KILO_PASS_TIER_199_MONTHLY_PRICE_ID ||= 'price_test_kilo_pass_tier_199_monthly';
  env.STRIPE_KILO_PASS_TIER_199_YEARLY_PRICE_ID ||= 'price_test_kilo_pass_tier_199_yearly';
}

async function getKiloPassPriceId(params: {
  tier: KiloPassTier;
  cadence: KiloPassCadence;
}): Promise<string> {
  ensureKiloPassStripePriceIdEnv();
  const { getStripePriceIdForKiloPass } = await import('@/lib/kilo-pass/stripe-price-ids.server');
  return getStripePriceIdForKiloPass(params);
}

function makeStripeSubscription(params: {
  id: string;
  start_date_seconds: number;
  metadata: Stripe.Metadata;
  status?: Stripe.Subscription.Status;
  ended_at?: number | null;
}): Stripe.Subscription {
  return {
    id: params.id,
    object: 'subscription',
    start_date: params.start_date_seconds,
    metadata: params.metadata,
    status: params.status ?? 'active',
    ended_at: params.ended_at ?? null,
    items: { object: 'list', data: [], has_more: false, url: '/v1/subscription_items' },
  } as unknown as Stripe.Subscription;
}

function kiloPassMetadata(params: {
  kiloUserId: string;
  tier: KiloPassTier;
  cadence: KiloPassCadence;
}): Stripe.Metadata {
  return {
    type: 'kilo-pass',
    kiloUserId: params.kiloUserId,
    tier: params.tier,
    cadence: params.cadence,
  };
}

function makeStripeInvoice(params: {
  id: string;
  amount_paid_cents: number;
  created_seconds?: number;
  subscriptionIdOrExpanded?: string | Stripe.Subscription | null;
  metadata?: Stripe.Metadata | null;
  priceId: string | null;
  paymentIntentId?: string | null;
}): Stripe.Invoice {
  const subscriptionUnion = params.subscriptionIdOrExpanded ?? null;
  const metadata = params.metadata ?? null;
  const priceId = params.priceId;
  const paymentIntentId = params.paymentIntentId ?? null;

  const result: Record<string, unknown> = {
    id: params.id,
    object: 'invoice',
    amount_paid: params.amount_paid_cents,
    created: params.created_seconds,
    payment_intent: paymentIntentId,
    parent:
      subscriptionUnion === null && metadata === null
        ? null
        : {
            subscription_details:
              subscriptionUnion === null && metadata === null
                ? null
                : {
                    subscription: subscriptionUnion ?? undefined,
                    metadata: metadata ?? undefined,
                  },
          },
    lines: {
      object: 'list',
      has_more: false,
      url: '/v1/invoices/inv_test/lines',
      data:
        priceId === null
          ? []
          : [
              {
                id: `il_${Math.random()}`,
                object: 'line_item',
                pricing: {
                  price_details: { price: priceId },
                },
              },
            ],
    },
  };

  return result as unknown as Stripe.Invoice;
}

async function insertPaymentMethod(params: {
  userId: string;
  stripeId: string;
  fingerprint: string;
}): Promise<void> {
  await db.insert(payment_methods).values({
    id: randomUUID(),
    user_id: params.userId,
    stripe_id: params.stripeId,
    stripe_fingerprint: params.fingerprint,
    eligible_for_free_credits: true,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });
}

async function insertKiloPassSubscription(params: {
  kiloUserId: string;
  stripeSubscriptionId: string;
  tier: KiloPassTier;
  cadence: KiloPassCadence;
  status?: string;
  endedAt?: string | null;
}): Promise<string> {
  const [row] = await db
    .insert(kilo_pass_subscriptions)
    .values({
      kilo_user_id: params.kiloUserId,
      payment_provider: KiloPassPaymentProvider.Stripe,
      provider_subscription_id: params.stripeSubscriptionId,
      stripe_subscription_id: params.stripeSubscriptionId,
      tier: params.tier,
      cadence: params.cadence,
      status: (params.status ?? 'active') as Stripe.Subscription.Status,
      started_at: new Date().toISOString(),
      ended_at: params.endedAt ?? null,
      current_streak_months: 1,
    })
    .returning({ id: kilo_pass_subscriptions.id });

  return row.id;
}

beforeEach(async () => {
  ensureKiloPassStripePriceIdEnv();
  await cleanupDbForTest();
});

describe('card fingerprint gate', () => {
  test('blocks subscription when another user has active Kilo Pass with same card fingerprint', async () => {
    const { handleKiloPassInvoicePaid } =
      await import('@/lib/kilo-pass/stripe-handlers-invoice-paid');

    const existingUser = await insertTestUser({
      total_microdollars_acquired: 0,
      microdollars_used: 0,
    });
    const newUser = await insertTestUser({ total_microdollars_acquired: 0, microdollars_used: 0 });

    const fingerprint = `fp_same_card_${Math.random()}`;
    const existingPmId = `pm_existing_${Math.random()}`;
    const newPmId = `pm_new_${Math.random()}`;

    await insertPaymentMethod({ userId: existingUser.id, stripeId: existingPmId, fingerprint });
    await insertPaymentMethod({ userId: newUser.id, stripeId: newPmId, fingerprint });

    const existingSubId = `sub_existing_${Math.random()}`;
    await insertKiloPassSubscription({
      kiloUserId: existingUser.id,
      stripeSubscriptionId: existingSubId,
      tier: KiloPassTier.Tier19,
      cadence: KiloPassCadence.Monthly,
    });

    const newSubId = `sub_new_${Math.random()}`;
    const meta = kiloPassMetadata({
      kiloUserId: newUser.id,
      tier: KiloPassTier.Tier19,
      cadence: KiloPassCadence.Monthly,
    });
    const subscription = makeStripeSubscription({
      id: newSubId,
      start_date_seconds: 1_735_689_600,
      metadata: meta,
    });

    const priceId = await getKiloPassPriceId({
      tier: KiloPassTier.Tier19,
      cadence: KiloPassCadence.Monthly,
    });

    const paymentIntentId = `pi_new_${Math.random()}`;
    const invoice = makeStripeInvoice({
      id: `inv_dup_${Math.random()}`,
      amount_paid_cents: 1900,
      created_seconds: 1_735_689_600,
      priceId,
      subscriptionIdOrExpanded: newSubId,
      metadata: meta,
      paymentIntentId,
    });

    const mockCancel = jest.fn(async () => ({
      id: newSubId,
      status: 'canceled',
    })) as unknown as jest.Mock;
    const mockRefund = jest.fn(async () => ({ id: `re_${Math.random()}` })) as unknown as jest.Mock;
    const mockRetrievePm = jest.fn(async () => ({
      id: newPmId,
      card: { fingerprint },
    }));
    const mockRetrieveSub = jest.fn(async () => subscription);

    const stripe = {
      subscriptions: { retrieve: mockRetrieveSub, cancel: mockCancel },
      refunds: { create: mockRefund },
      paymentMethods: { retrieve: mockRetrievePm },
      paymentIntents: {
        retrieve: jest.fn(async () => ({ id: paymentIntentId, payment_method: newPmId })),
      },
    };

    await handleKiloPassInvoicePaid({
      eventId: 'evt_dup_test_1',
      invoice,
      stripe: stripe as unknown as Stripe,
    });

    expect(mockCancel).toHaveBeenCalledWith(newSubId, {
      invoice_now: false,
      prorate: false,
    });
    expect(mockRefund).toHaveBeenCalledWith(
      expect.objectContaining({
        payment_intent: paymentIntentId,
        reason: 'duplicate',
      })
    );

    const newSubRow = await db.query.kilo_pass_subscriptions.findFirst({
      where: eq(kilo_pass_subscriptions.stripe_subscription_id, newSubId),
    });
    expect(newSubRow?.status).toBe('canceled');
    expect(newSubRow?.ended_at).not.toBeNull();

    const auditRows = await db
      .select({ action: kilo_pass_audit_log.action, payload: kilo_pass_audit_log.payload_json })
      .from(kilo_pass_audit_log)
      .where(eq(kilo_pass_audit_log.stripe_subscription_id, newSubId));
    const dupAudit = auditRows.find(
      r => r.action === KiloPassAuditLogAction.DuplicateCardSubscriptionCanceled
    );
    expect(dupAudit).toBeTruthy();
    expect((dupAudit?.payload as Record<string, unknown>)?.otherKiloUserId).toBe(existingUser.id);

    const creditRows = await db
      .select({ id: credit_transactions.id })
      .from(credit_transactions)
      .where(eq(credit_transactions.kilo_user_id, newUser.id));
    expect(creditRows).toHaveLength(0);

    const blockedUser = await db.query.kilocode_users.findFirst({
      columns: { blocked_reason: true, blocked_at: true },
      where: eq(kilocode_users.id, newUser.id),
    });
    expect(blockedUser?.blocked_reason).toBe('kilo_pass_duplicate_card');
    expect(blockedUser?.blocked_at).not.toBeNull();
  });

  test('does not block same user re-subscribing with the same card', async () => {
    const { handleKiloPassInvoicePaid } =
      await import('@/lib/kilo-pass/stripe-handlers-invoice-paid');

    const user = await insertTestUser({
      total_microdollars_acquired: 0,
      microdollars_used: 7_000_000,
    });

    const fingerprint = `fp_resub_${Math.random()}`;
    const pmId = `pm_resub_${Math.random()}`;

    await insertPaymentMethod({ userId: user.id, stripeId: pmId, fingerprint });

    const oldSubId = `sub_old_${Math.random()}`;
    await insertKiloPassSubscription({
      kiloUserId: user.id,
      stripeSubscriptionId: oldSubId,
      tier: KiloPassTier.Tier19,
      cadence: KiloPassCadence.Monthly,
      status: 'canceled',
      endedAt: new Date().toISOString(),
    });

    const newSubId = `sub_new_resub_${Math.random()}`;
    const meta = kiloPassMetadata({
      kiloUserId: user.id,
      tier: KiloPassTier.Tier19,
      cadence: KiloPassCadence.Monthly,
    });
    const subscription = makeStripeSubscription({
      id: newSubId,
      start_date_seconds: 1_735_689_600,
      metadata: meta,
    });

    const priceId = await getKiloPassPriceId({
      tier: KiloPassTier.Tier19,
      cadence: KiloPassCadence.Monthly,
    });

    const paymentIntentId = `pi_resub_${Math.random()}`;
    const invoice = makeStripeInvoice({
      id: `inv_resub_${Math.random()}`,
      amount_paid_cents: 1900,
      created_seconds: 1_735_689_600,
      priceId,
      subscriptionIdOrExpanded: newSubId,
      metadata: meta,
      paymentIntentId,
    });

    const mockCancel = jest.fn();
    const mockRefund = jest.fn();
    const mockRetrievePm = jest.fn(async () => ({
      id: pmId,
      card: { fingerprint },
    }));
    const mockRetrieveSub = jest.fn(async () => subscription);

    const stripe = {
      subscriptions: { retrieve: mockRetrieveSub, cancel: mockCancel },
      refunds: { create: mockRefund },
      paymentMethods: { retrieve: mockRetrievePm },
      paymentIntents: {
        retrieve: jest.fn(async () => ({ id: paymentIntentId, payment_method: pmId })),
      },
    };

    await handleKiloPassInvoicePaid({
      eventId: 'evt_resub_test',
      invoice,
      stripe: stripe as unknown as Stripe,
    });

    expect(mockCancel).not.toHaveBeenCalled();
    expect(mockRefund).not.toHaveBeenCalled();

    const newSubRow = await db.query.kilo_pass_subscriptions.findFirst({
      where: eq(kilo_pass_subscriptions.stripe_subscription_id, newSubId),
    });
    expect(newSubRow?.status).toBe('active');

    const auditRows = await db
      .select({ action: kilo_pass_audit_log.action })
      .from(kilo_pass_audit_log)
      .where(eq(kilo_pass_audit_log.stripe_subscription_id, newSubId));
    const dupAudit = auditRows.find(
      r => r.action === KiloPassAuditLogAction.DuplicateCardSubscriptionCanceled
    );
    expect(dupAudit).toBeUndefined();

    const creditRows = await db
      .select({ id: credit_transactions.id })
      .from(credit_transactions)
      .where(
        and(
          eq(credit_transactions.kilo_user_id, user.id),
          eq(credit_transactions.description, 'Kilo Pass base credits (tier_19, monthly)')
        )
      );
    expect(creditRows.length).toBeGreaterThanOrEqual(1);

    const userRow = await db.query.kilocode_users.findFirst({
      columns: { blocked_reason: true },
      where: eq(kilocode_users.id, user.id),
    });
    expect(userRow?.blocked_reason).toBeNull();
  });

  test('does not overwrite existing blocked_reason when user is already blocked', async () => {
    const { handleKiloPassInvoicePaid } =
      await import('@/lib/kilo-pass/stripe-handlers-invoice-paid');

    const existingUser = await insertTestUser({
      total_microdollars_acquired: 0,
      microdollars_used: 0,
    });
    const newUser = await insertTestUser({
      total_microdollars_acquired: 0,
      microdollars_used: 0,
      blocked_reason: 'preexisting_block',
      blocked_at: new Date().toISOString(),
    });

    const fingerprint = `fp_already_blocked_${Math.random()}`;
    const existingPmId = `pm_already_blocked_existing_${Math.random()}`;
    const newPmId = `pm_already_blocked_new_${Math.random()}`;

    await insertPaymentMethod({ userId: existingUser.id, stripeId: existingPmId, fingerprint });
    await insertPaymentMethod({ userId: newUser.id, stripeId: newPmId, fingerprint });

    const existingSubId = `sub_already_blocked_existing_${Math.random()}`;
    await insertKiloPassSubscription({
      kiloUserId: existingUser.id,
      stripeSubscriptionId: existingSubId,
      tier: KiloPassTier.Tier19,
      cadence: KiloPassCadence.Monthly,
    });

    const newSubId = `sub_already_blocked_new_${Math.random()}`;
    const meta = kiloPassMetadata({
      kiloUserId: newUser.id,
      tier: KiloPassTier.Tier19,
      cadence: KiloPassCadence.Monthly,
    });
    const subscription = makeStripeSubscription({
      id: newSubId,
      start_date_seconds: 1_735_689_600,
      metadata: meta,
    });

    const priceId = await getKiloPassPriceId({
      tier: KiloPassTier.Tier19,
      cadence: KiloPassCadence.Monthly,
    });

    const paymentIntentId = `pi_already_blocked_${Math.random()}`;
    const invoice = makeStripeInvoice({
      id: `inv_already_blocked_${Math.random()}`,
      amount_paid_cents: 1900,
      created_seconds: 1_735_689_600,
      priceId,
      subscriptionIdOrExpanded: newSubId,
      metadata: meta,
      paymentIntentId,
    });

    const mockCancel = jest.fn(async () => ({
      id: newSubId,
      status: 'canceled',
    }));
    const mockRefund = jest.fn(async () => ({ id: `re_${Math.random()}` }));
    const mockRetrievePm = jest.fn(async () => ({
      id: newPmId,
      card: { fingerprint },
    }));
    const mockRetrieveSub = jest.fn(async () => subscription);

    const stripe = {
      subscriptions: { retrieve: mockRetrieveSub, cancel: mockCancel },
      refunds: { create: mockRefund },
      paymentMethods: { retrieve: mockRetrievePm },
      paymentIntents: {
        retrieve: jest.fn(async () => ({ id: paymentIntentId, payment_method: newPmId })),
      },
    };

    await handleKiloPassInvoicePaid({
      eventId: 'evt_already_blocked_test',
      invoice,
      stripe: stripe as unknown as Stripe,
    });

    const blockedUser = await db.query.kilocode_users.findFirst({
      columns: { blocked_reason: true },
      where: eq(kilocode_users.id, newUser.id),
    });
    expect(blockedUser?.blocked_reason).toBe('preexisting_block');
  });

  test('does not block when other user has ended Kilo Pass with same fingerprint', async () => {
    const { handleKiloPassInvoicePaid } =
      await import('@/lib/kilo-pass/stripe-handlers-invoice-paid');

    const otherUser = await insertTestUser({
      total_microdollars_acquired: 0,
      microdollars_used: 0,
    });
    const newUser = await insertTestUser({
      total_microdollars_acquired: 0,
      microdollars_used: 7_000_000,
    });

    const fingerprint = `fp_ended_${Math.random()}`;
    const otherPmId = `pm_other_ended_${Math.random()}`;
    const newPmId = `pm_new_ended_${Math.random()}`;

    await insertPaymentMethod({ userId: otherUser.id, stripeId: otherPmId, fingerprint });
    await insertPaymentMethod({ userId: newUser.id, stripeId: newPmId, fingerprint });

    const otherSubId = `sub_other_ended_${Math.random()}`;
    await insertKiloPassSubscription({
      kiloUserId: otherUser.id,
      stripeSubscriptionId: otherSubId,
      tier: KiloPassTier.Tier19,
      cadence: KiloPassCadence.Monthly,
      status: 'canceled',
      endedAt: new Date().toISOString(),
    });

    const newSubId = `sub_new_ended_${Math.random()}`;
    const meta = kiloPassMetadata({
      kiloUserId: newUser.id,
      tier: KiloPassTier.Tier19,
      cadence: KiloPassCadence.Monthly,
    });
    const subscription = makeStripeSubscription({
      id: newSubId,
      start_date_seconds: 1_735_689_600,
      metadata: meta,
    });

    const priceId = await getKiloPassPriceId({
      tier: KiloPassTier.Tier19,
      cadence: KiloPassCadence.Monthly,
    });

    const paymentIntentId = `pi_ended_${Math.random()}`;
    const invoice = makeStripeInvoice({
      id: `inv_ended_${Math.random()}`,
      amount_paid_cents: 1900,
      created_seconds: 1_735_689_600,
      priceId,
      subscriptionIdOrExpanded: newSubId,
      metadata: meta,
      paymentIntentId,
    });

    const mockCancel = jest.fn();
    const mockRefund = jest.fn();
    const mockRetrievePm = jest.fn(async () => ({
      id: newPmId,
      card: { fingerprint },
    }));
    const mockRetrieveSub = jest.fn(async () => subscription);

    const stripe = {
      subscriptions: { retrieve: mockRetrieveSub, cancel: mockCancel },
      refunds: { create: mockRefund },
      paymentMethods: { retrieve: mockRetrievePm },
      paymentIntents: {
        retrieve: jest.fn(async () => ({ id: paymentIntentId, payment_method: newPmId })),
      },
    };

    await handleKiloPassInvoicePaid({
      eventId: 'evt_ended_test',
      invoice,
      stripe: stripe as unknown as Stripe,
    });

    expect(mockCancel).not.toHaveBeenCalled();

    const newSubRow = await db.query.kilo_pass_subscriptions.findFirst({
      where: eq(kilo_pass_subscriptions.stripe_subscription_id, newSubId),
    });
    expect(newSubRow?.status).toBe('active');

    const creditRows = await db
      .select({ id: credit_transactions.id })
      .from(credit_transactions)
      .where(
        and(
          eq(credit_transactions.kilo_user_id, newUser.id),
          eq(credit_transactions.description, 'Kilo Pass base credits (tier_19, monthly)')
        )
      );
    expect(creditRows.length).toBeGreaterThanOrEqual(1);
  });

  test('does not block when no payment method fingerprint is available', async () => {
    const { handleKiloPassInvoicePaid } =
      await import('@/lib/kilo-pass/stripe-handlers-invoice-paid');

    const user = await insertTestUser({
      total_microdollars_acquired: 0,
      microdollars_used: 7_000_000,
    });

    const newSubId = `sub_no_fp_${Math.random()}`;
    const meta = kiloPassMetadata({
      kiloUserId: user.id,
      tier: KiloPassTier.Tier19,
      cadence: KiloPassCadence.Monthly,
    });
    const subscription = makeStripeSubscription({
      id: newSubId,
      start_date_seconds: 1_735_689_600,
      metadata: meta,
    });

    const priceId = await getKiloPassPriceId({
      tier: KiloPassTier.Tier19,
      cadence: KiloPassCadence.Monthly,
    });

    const invoice = makeStripeInvoice({
      id: `inv_no_fp_${Math.random()}`,
      amount_paid_cents: 1900,
      created_seconds: 1_735_689_600,
      priceId,
      subscriptionIdOrExpanded: newSubId,
      metadata: meta,
      paymentIntentId: null,
    });

    const mockCancel = jest.fn();
    const mockRetrieveSub = jest.fn(async () => subscription);

    const stripe = {
      subscriptions: { retrieve: mockRetrieveSub, cancel: mockCancel },
      refunds: { create: jest.fn() },
      paymentMethods: { retrieve: jest.fn() },
      paymentIntents: { retrieve: jest.fn() },
    };

    await handleKiloPassInvoicePaid({
      eventId: 'evt_no_fp_test',
      invoice,
      stripe: stripe as unknown as Stripe,
    });

    expect(mockCancel).not.toHaveBeenCalled();

    const newSubRow = await db.query.kilo_pass_subscriptions.findFirst({
      where: eq(kilo_pass_subscriptions.stripe_subscription_id, newSubId),
    });
    expect(newSubRow?.status).toBe('active');
  });

  test('writes transactional_email_log marker and sends notification when blocked', async () => {
    const { handleKiloPassInvoicePaid } =
      await import('@/lib/kilo-pass/stripe-handlers-invoice-paid');

    const existingUser = await insertTestUser({
      total_microdollars_acquired: 0,
      microdollars_used: 0,
    });
    const newUser = await insertTestUser({ total_microdollars_acquired: 0, microdollars_used: 0 });

    const fingerprint = `fp_email_${Math.random()}`;
    const existingPmId = `pm_email_existing_${Math.random()}`;
    const newPmId = `pm_email_new_${Math.random()}`;

    await insertPaymentMethod({ userId: existingUser.id, stripeId: existingPmId, fingerprint });
    await insertPaymentMethod({ userId: newUser.id, stripeId: newPmId, fingerprint });

    const existingSubId = `sub_email_existing_${Math.random()}`;
    await insertKiloPassSubscription({
      kiloUserId: existingUser.id,
      stripeSubscriptionId: existingSubId,
      tier: KiloPassTier.Tier19,
      cadence: KiloPassCadence.Monthly,
    });

    const newSubId = `sub_email_new_${Math.random()}`;
    const meta = kiloPassMetadata({
      kiloUserId: newUser.id,
      tier: KiloPassTier.Tier19,
      cadence: KiloPassCadence.Monthly,
    });
    const subscription = makeStripeSubscription({
      id: newSubId,
      start_date_seconds: 1_735_689_600,
      metadata: meta,
    });

    const priceId = await getKiloPassPriceId({
      tier: KiloPassTier.Tier19,
      cadence: KiloPassCadence.Monthly,
    });

    const invoiceId = `inv_email_${Math.random()}`;
    const paymentIntentId = `pi_email_${Math.random()}`;
    const invoice = makeStripeInvoice({
      id: invoiceId,
      amount_paid_cents: 1900,
      created_seconds: 1_735_689_600,
      priceId,
      subscriptionIdOrExpanded: newSubId,
      metadata: meta,
      paymentIntentId,
    });

    const mockCancel = jest.fn(async () => ({
      id: newSubId,
      status: 'canceled',
    }));
    const mockRefund = jest.fn(async () => ({ id: `re_${Math.random()}` }));
    const mockRetrievePm = jest.fn(async () => ({
      id: newPmId,
      card: { fingerprint },
    }));
    const mockRetrieveSub = jest.fn(async () => subscription);

    const stripe = {
      subscriptions: { retrieve: mockRetrieveSub, cancel: mockCancel },
      refunds: { create: mockRefund },
      paymentMethods: { retrieve: mockRetrievePm },
      paymentIntents: {
        retrieve: jest.fn(async () => ({ id: paymentIntentId, payment_method: newPmId })),
      },
    };

    await handleKiloPassInvoicePaid({
      eventId: 'evt_email_test',
      invoice,
      stripe: stripe as unknown as Stripe,
    });

    const emailLogRows = await db
      .select({
        email_type: transactional_email_log.email_type,
        idempotency_key: transactional_email_log.idempotency_key,
      })
      .from(transactional_email_log)
      .where(
        and(
          eq(transactional_email_log.user_id, newUser.id),
          eq(transactional_email_log.email_type, 'kilo_pass_duplicate_card_canceled')
        )
      );
    expect(emailLogRows).toHaveLength(1);
    expect(emailLogRows[0].idempotency_key).toBe(invoiceId);
  });

  test('race condition: second webhook replay does not send duplicate email', async () => {
    const { handleKiloPassInvoicePaid } =
      await import('@/lib/kilo-pass/stripe-handlers-invoice-paid');

    const existingUser = await insertTestUser({
      total_microdollars_acquired: 0,
      microdollars_used: 0,
    });
    const newUser = await insertTestUser({ total_microdollars_acquired: 0, microdollars_used: 0 });

    const fingerprint = `fp_race_${Math.random()}`;
    const existingPmId = `pm_race_existing_${Math.random()}`;
    const newPmId = `pm_race_new_${Math.random()}`;

    await insertPaymentMethod({ userId: existingUser.id, stripeId: existingPmId, fingerprint });
    await insertPaymentMethod({ userId: newUser.id, stripeId: newPmId, fingerprint });

    const existingSubId = `sub_race_existing_${Math.random()}`;
    await insertKiloPassSubscription({
      kiloUserId: existingUser.id,
      stripeSubscriptionId: existingSubId,
      tier: KiloPassTier.Tier19,
      cadence: KiloPassCadence.Monthly,
    });

    const newSubId = `sub_race_new_${Math.random()}`;
    const meta = kiloPassMetadata({
      kiloUserId: newUser.id,
      tier: KiloPassTier.Tier19,
      cadence: KiloPassCadence.Monthly,
    });
    const subscription = makeStripeSubscription({
      id: newSubId,
      start_date_seconds: 1_735_689_600,
      metadata: meta,
    });

    const priceId = await getKiloPassPriceId({
      tier: KiloPassTier.Tier19,
      cadence: KiloPassCadence.Monthly,
    });

    const invoiceId = `inv_race_${Math.random()}`;
    const paymentIntentId = `pi_race_${Math.random()}`;
    const invoice = makeStripeInvoice({
      id: invoiceId,
      amount_paid_cents: 1900,
      created_seconds: 1_735_689_600,
      priceId,
      subscriptionIdOrExpanded: newSubId,
      metadata: meta,
      paymentIntentId,
    });

    const mockCancel = jest.fn(async () => ({
      id: newSubId,
      status: 'canceled',
    }));
    const mockRefund = jest.fn(async () => ({ id: `re_${Math.random()}` }));
    const mockRetrievePm = jest.fn(async () => ({
      id: newPmId,
      card: { fingerprint },
    }));
    const mockRetrieveSub = jest.fn(async () => subscription);

    const stripe = {
      subscriptions: { retrieve: mockRetrieveSub, cancel: mockCancel },
      refunds: { create: mockRefund },
      paymentMethods: { retrieve: mockRetrievePm },
      paymentIntents: {
        retrieve: jest.fn(async () => ({ id: paymentIntentId, payment_method: newPmId })),
      },
    };

    await handleKiloPassInvoicePaid({
      eventId: 'evt_race_first',
      invoice,
      stripe: stripe as unknown as Stripe,
    });

    await handleKiloPassInvoicePaid({
      eventId: 'evt_race_second',
      invoice,
      stripe: stripe as unknown as Stripe,
    });

    const emailLogRows = await db
      .select({ idempotency_key: transactional_email_log.idempotency_key })
      .from(transactional_email_log)
      .where(
        and(
          eq(transactional_email_log.user_id, newUser.id),
          eq(transactional_email_log.email_type, 'kilo_pass_duplicate_card_canceled')
        )
      );
    expect(emailLogRows).toHaveLength(1);

    const auditRows = await db
      .select({ action: kilo_pass_audit_log.action })
      .from(kilo_pass_audit_log)
      .where(eq(kilo_pass_audit_log.stripe_subscription_id, newSubId));
    const dupAuditCount = auditRows.filter(
      r => r.action === KiloPassAuditLogAction.DuplicateCardSubscriptionCanceled
    ).length;
    expect(dupAuditCount).toBeGreaterThanOrEqual(1);
  });
});

describe('findActiveKiloPassByCardFingerprint', () => {
  test('returns null when no other user has the fingerprint', async () => {
    const { findActiveKiloPassByCardFingerprint } =
      await import('@/lib/kilo-pass/card-fingerprint-gate');

    const result = await findActiveKiloPassByCardFingerprint(
      'fp_nonexistent',
      'user_does_not_matter'
    );
    expect(result).toBeNull();
  });

  test('returns active subscription when another user has active Kilo Pass with same fingerprint', async () => {
    const { findActiveKiloPassByCardFingerprint } =
      await import('@/lib/kilo-pass/card-fingerprint-gate');

    const otherUser = await insertTestUser();
    const fingerprint = `fp_find_${Math.random()}`;

    await insertPaymentMethod({
      userId: otherUser.id,
      stripeId: `pm_find_other_${Math.random()}`,
      fingerprint,
    });

    const subId = `sub_find_${Math.random()}`;
    const kpSubId = await insertKiloPassSubscription({
      kiloUserId: otherUser.id,
      stripeSubscriptionId: subId,
      tier: KiloPassTier.Tier19,
      cadence: KiloPassCadence.Monthly,
    });

    const result = await findActiveKiloPassByCardFingerprint(fingerprint, 'some_other_user_id');
    expect(result).not.toBeNull();
    expect(result?.kiloUserId).toBe(otherUser.id);
    expect(result?.subscriptionId).toBe(kpSubId);
    expect(result?.stripeSubscriptionId).toBe(subId);
  });

  test('returns null when other user has same fingerprint but ended Kilo Pass', async () => {
    const { findActiveKiloPassByCardFingerprint } =
      await import('@/lib/kilo-pass/card-fingerprint-gate');

    const otherUser = await insertTestUser();
    const fingerprint = `fp_ended_find_${Math.random()}`;

    await insertPaymentMethod({
      userId: otherUser.id,
      stripeId: `pm_ended_find_${Math.random()}`,
      fingerprint,
    });

    await insertKiloPassSubscription({
      kiloUserId: otherUser.id,
      stripeSubscriptionId: `sub_ended_find_${Math.random()}`,
      tier: KiloPassTier.Tier19,
      cadence: KiloPassCadence.Monthly,
      status: 'canceled',
      endedAt: new Date().toISOString(),
    });

    const result = await findActiveKiloPassByCardFingerprint(fingerprint, 'some_other_user_id');
    expect(result).toBeNull();
  });

  test('excludes the excludingUserId from the lookup', async () => {
    const { findActiveKiloPassByCardFingerprint } =
      await import('@/lib/kilo-pass/card-fingerprint-gate');

    const user = await insertTestUser();
    const fingerprint = `fp_self_${Math.random()}`;

    await insertPaymentMethod({
      userId: user.id,
      stripeId: `pm_self_${Math.random()}`,
      fingerprint,
    });

    await insertKiloPassSubscription({
      kiloUserId: user.id,
      stripeSubscriptionId: `sub_self_${Math.random()}`,
      tier: KiloPassTier.Tier19,
      cadence: KiloPassCadence.Monthly,
    });

    const result = await findActiveKiloPassByCardFingerprint(fingerprint, user.id);
    expect(result).toBeNull();
  });
});
