import { beforeEach, describe, expect, jest, test } from '@jest/globals';

import { db, cleanupDbForTest } from '@/lib/drizzle';
import {
  credit_transactions,
  kilocode_users,
  kilo_pass_audit_log,
  kilo_pass_issuance_items,
  kilo_pass_issuances,
  kilo_pass_scheduled_changes,
  kilo_pass_subscriptions,
} from '@kilocode/db/schema';
import { KiloPassAuditLogAction } from './enums';
import { KiloPassIssuanceItemKind } from './enums';
import { KiloPassIssuanceSource } from './enums';
import { KiloPassCadence } from './enums';
import { KiloPassScheduledChangeStatus } from './enums';
import { KiloPassTier } from '@/lib/kilo-pass/enums';
import { insertTestUser } from '@/tests/helpers/user.helper';
import { and, eq } from 'drizzle-orm';
import type Stripe from 'stripe';
import { randomUUID } from 'node:crypto';

function ensureKiloPassStripePriceIdEnv(): void {
  // These env vars are required at module-load time by [`getKnownStripePriceIdsForKiloPass()`](src/lib/kilo-pass/stripe-price-ids.server.ts:24).
  // If the host env already provides them, don't overwrite.
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
  canceled_at?: number | null;
}): Stripe.Subscription {
  return {
    id: params.id,
    object: 'subscription',
    start_date: params.start_date_seconds,
    metadata: params.metadata,
    status: params.status ?? 'active',
    ended_at: params.ended_at ?? null,
    canceled_at: params.canceled_at ?? null,
    items: { object: 'list', data: [], has_more: false, url: '/v1/subscription_items' },
    // Everything else is irrelevant for our handler.
  } as unknown as Stripe.Subscription;
}

function makeStripeInvoice(params: {
  id: string;
  amount_paid_cents: number;
  period_start_seconds?: number;
  created_seconds?: number;
  paid_seconds?: number;
  subscriptionIdOrExpanded?: string | Stripe.Subscription | null;
  metadata?: Stripe.Metadata | null;
  priceId: string | null;
  invoicePaymentId?: string | null;
}): Stripe.Invoice {
  const subscriptionUnion = params.subscriptionIdOrExpanded ?? null;
  const metadata = params.metadata ?? null;
  const priceId = params.priceId;
  const invoicePaymentId = params.invoicePaymentId ?? null;

  // Stripe types for nested invoice payloads are fairly strict; for this unit/integration test we
  // only need the fields our handler reads.
  return {
    id: params.id,
    object: 'invoice',
    amount_paid: params.amount_paid_cents,
    period_start: params.period_start_seconds,
    created: params.created_seconds,
    status_transitions:
      typeof params.paid_seconds === 'number'
        ? ({ paid_at: params.paid_seconds } as Stripe.Invoice.StatusTransitions)
        : null,
    payments:
      invoicePaymentId === null
        ? undefined
        : ({
            object: 'list',
            has_more: false,
            url: `/v1/invoices/${params.id}/payments`,
            data: [
              {
                id: invoicePaymentId,
                object: 'invoice_payment',
                amount_paid: params.amount_paid_cents,
                amount_requested: params.amount_paid_cents,
                created: params.created_seconds ?? 1_735_689_600,
                currency: 'usd',
                invoice: params.id,
                is_default: true,
                livemode: false,
                payment: { type: 'payment_intent', payment_intent: `pi_${Math.random()}` },
                status: 'paid',
                status_transitions: { canceled_at: null, paid_at: params.paid_seconds ?? null },
              } as unknown as Stripe.InvoicePayment,
            ],
          } as unknown as Stripe.ApiList<Stripe.InvoicePayment>),
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
          : ([
              {
                id: `il_${Math.random()}`,
                object: 'line_item',
                pricing: {
                  price_details: { price: priceId },
                },
              },
            ] as unknown as Stripe.InvoiceLineItem[]),
    },
  } as unknown as Stripe.Invoice;
}

function kiloPassMetadata(params: {
  kiloUserId: string;
  tier: KiloPassTier;
  cadence: KiloPassCadence;
  kiloPassScheduledChangeId?: string;
}): Stripe.Metadata {
  return {
    type: 'kilo-pass',
    kiloUserId: params.kiloUserId,
    tier: params.tier,
    cadence: params.cadence,
    ...(params.kiloPassScheduledChangeId
      ? { kiloPassScheduledChangeId: params.kiloPassScheduledChangeId }
      : {}),
  };
}

beforeEach(async () => {
  ensureKiloPassStripePriceIdEnv();
  await cleanupDbForTest();
});

describe('handleKiloPassInvoicePaid', () => {
  test('returns early when invoice does not look like Kilo Pass (no DB side effects)', async () => {
    const { handleKiloPassInvoicePaid } =
      await import('@/lib/kilo-pass/stripe-handlers-invoice-paid');

    const retrieve = jest.fn();
    const stripe = {
      subscriptions: {
        retrieve,
      },
    };

    const invoice = makeStripeInvoice({
      id: `inv_non_kilo_${Math.random()}`,
      amount_paid_cents: 1900,
      created_seconds: 1_735_689_600,
      priceId: null,
      subscriptionIdOrExpanded: null,
      metadata: null,
    });

    await handleKiloPassInvoicePaid({
      eventId: 'evt_test_1',
      invoice,
      stripe: stripe as unknown as Stripe,
    });

    expect(retrieve).not.toHaveBeenCalled();

    const subs = await db.select({ id: kilo_pass_subscriptions.id }).from(kilo_pass_subscriptions);
    expect(subs).toHaveLength(0);
  });

  test('throws when Kilo Pass invoice has no subscription reference', async () => {
    const { handleKiloPassInvoicePaid } =
      await import('@/lib/kilo-pass/stripe-handlers-invoice-paid');

    const priceId = await getKiloPassPriceId({
      tier: KiloPassTier.Tier19,
      cadence: KiloPassCadence.Monthly,
    });
    const invoice = makeStripeInvoice({
      id: `inv_missing_sub_${Math.random()}`,
      amount_paid_cents: 1900,
      created_seconds: 1_735_689_600,
      priceId,
      subscriptionIdOrExpanded: null,
      metadata: null,
    });

    const retrieve = jest.fn();
    const stripe = {
      subscriptions: {
        retrieve,
      },
    };

    await expect(
      handleKiloPassInvoicePaid({
        eventId: 'evt_test_2',
        invoice,
        stripe: stripe as unknown as Stripe,
      })
    ).rejects.toThrow('Kilo Pass invoice has no subscription reference');

    expect(retrieve).not.toHaveBeenCalled();
  });

  test('monthly: first invoice creates subscription, issuance, base credits; sets streak=1', async () => {
    const { handleKiloPassInvoicePaid } =
      await import('@/lib/kilo-pass/stripe-handlers-invoice-paid');

    const user = await insertTestUser({
      total_microdollars_acquired: 0,
      microdollars_used: 7_000_000,
    });
    const stripeSubId = `sub_${Math.random()}`;

    const meta = kiloPassMetadata({
      kiloUserId: user.id,
      tier: KiloPassTier.Tier19,
      cadence: KiloPassCadence.Monthly,
    });

    const subscription = makeStripeSubscription({
      id: stripeSubId,
      start_date_seconds: 1_735_689_600,
      metadata: meta,
    });

    const retrieve = jest.fn(async () => subscription);
    const stripe = {
      subscriptions: {
        retrieve,
      },
    };

    const invoiceId = `inv_monthly_first_${Math.random()}`;
    const invoicePaymentId = `inpay_${Math.random()}`;
    const priceId = await getKiloPassPriceId({
      tier: KiloPassTier.Tier19,
      cadence: KiloPassCadence.Monthly,
    });
    const invoice = makeStripeInvoice({
      id: invoiceId,
      // Intentionally not equal to the tier-config amount (e.g. taxes/discounts/proration).
      // The handler should still use tier-config pricing for threshold updates.
      amount_paid_cents: 1234,
      period_start_seconds: 1_767_225_600, // 2026-01-01T00:00:00Z
      created_seconds: 1_767_225_600,
      priceId,
      subscriptionIdOrExpanded: stripeSubId,
      metadata: meta,
      invoicePaymentId,
    });

    await handleKiloPassInvoicePaid({
      eventId: 'evt_test_3',
      invoice,
      stripe: stripe as unknown as Stripe,
    });

    const userRow = await db.query.kilocode_users.findFirst({
      where: eq(kilocode_users.id, user.id),
    });
    expect(userRow?.kilo_pass_threshold).toBe(7_000_000 + 1_900 * 10_000);

    const subRow = await db.query.kilo_pass_subscriptions.findFirst({
      where: eq(kilo_pass_subscriptions.stripe_subscription_id, stripeSubId),
    });
    expect(subRow).toBeTruthy();
    expect(subRow?.kilo_user_id).toBe(user.id);
    expect(subRow?.tier).toBe(KiloPassTier.Tier19);
    expect(subRow?.cadence).toBe(KiloPassCadence.Monthly);
    expect(subRow?.status).toBe('active');
    expect(subRow?.current_streak_months).toBe(1);

    const issuance = await db.query.kilo_pass_issuances.findFirst({
      where: and(
        eq(kilo_pass_issuances.kilo_pass_subscription_id, subRow?.id ?? ''),
        eq(kilo_pass_issuances.stripe_invoice_id, invoiceId)
      ),
    });
    expect(issuance).toBeTruthy();

    const items = await db
      .select({
        kind: kilo_pass_issuance_items.kind,
        creditTransactionId: kilo_pass_issuance_items.credit_transaction_id,
      })
      .from(kilo_pass_issuance_items)
      .where(eq(kilo_pass_issuance_items.kilo_pass_issuance_id, issuance?.id ?? ''));

    const itemKinds = items.map(i => i.kind).sort();
    expect(itemKinds).toEqual([KiloPassIssuanceItemKind.Base]);

    const creditRows = await db
      .select({
        id: credit_transactions.id,
        isFree: credit_transactions.is_free,
        amountMicrodollars: credit_transactions.amount_microdollars,
        stripePaymentId: credit_transactions.stripe_payment_id,
      })
      .from(credit_transactions)
      .where(
        and(
          eq(credit_transactions.kilo_user_id, user.id),
          eq(credit_transactions.description, 'Kilo Pass base credits (tier_19, monthly)')
        )
      );

    expect(creditRows).toHaveLength(1);
    expect(creditRows[0]?.isFree).toBe(false);
    expect(creditRows[0]?.amountMicrodollars).toBe(19_000_000);
    // We treat the Stripe invoice ID as the canonical paid-credit idempotency key.
    expect(creditRows[0]?.stripePaymentId).toBe(invoiceId);

    const auditActions = await db
      .select({ action: kilo_pass_audit_log.action })
      .from(kilo_pass_audit_log)
      .where(eq(kilo_pass_audit_log.stripe_invoice_id, invoiceId));

    expect(auditActions.map(a => a.action)).toEqual(
      expect.arrayContaining([
        KiloPassAuditLogAction.StripeWebhookReceived,
        KiloPassAuditLogAction.KiloPassInvoicePaidHandled,
        KiloPassAuditLogAction.BaseCreditsIssued,
      ])
    );
  });

  test('monthly: retry of first invoice is idempotent (does not double-issue base credits)', async () => {
    const { handleKiloPassInvoicePaid } =
      await import('@/lib/kilo-pass/stripe-handlers-invoice-paid');

    const user = await insertTestUser({ total_microdollars_acquired: 0, microdollars_used: 0 });
    const stripeSubId = `sub_${Math.random()}`;
    const invoiceId = `inv_retry_${Math.random()}`;

    const meta = kiloPassMetadata({
      kiloUserId: user.id,
      tier: KiloPassTier.Tier19,
      cadence: KiloPassCadence.Monthly,
    });
    const subscription = makeStripeSubscription({
      id: stripeSubId,
      start_date_seconds: 1_735_689_600,
      metadata: meta,
    });

    const retrieve = jest.fn(async () => subscription);
    const stripe = {
      subscriptions: {
        retrieve,
      },
    };

    const priceId = await getKiloPassPriceId({
      tier: KiloPassTier.Tier19,
      cadence: KiloPassCadence.Monthly,
    });
    const invoice = makeStripeInvoice({
      id: invoiceId,
      amount_paid_cents: 1900,
      created_seconds: 1_735_689_600,
      priceId,
      subscriptionIdOrExpanded: stripeSubId,
      metadata: meta,
    });

    await handleKiloPassInvoicePaid({
      eventId: 'evt_test_4a',
      invoice,
      stripe: stripe as unknown as Stripe,
    });
    await handleKiloPassInvoicePaid({
      eventId: 'evt_test_4b',
      invoice,
      stripe: stripe as unknown as Stripe,
    });

    const issuance = await db.query.kilo_pass_issuances.findFirst({
      where: eq(kilo_pass_issuances.stripe_invoice_id, invoiceId),
    });
    expect(issuance).toBeTruthy();

    const kinds = await db
      .select({ kind: kilo_pass_issuance_items.kind })
      .from(kilo_pass_issuance_items)
      .where(eq(kilo_pass_issuance_items.kilo_pass_issuance_id, issuance?.id ?? ''));
    expect(kinds.map(k => k.kind).sort()).toEqual([KiloPassIssuanceItemKind.Base]);
  });

  test('monthly: streak counts consecutive months (no bonus is issued on invoice.paid)', async () => {
    const { handleKiloPassInvoicePaid } =
      await import('@/lib/kilo-pass/stripe-handlers-invoice-paid');

    const user = await insertTestUser({ total_microdollars_acquired: 0, microdollars_used: 0 });
    const stripeSubId = `sub_${Math.random()}`;
    const meta = kiloPassMetadata({
      kiloUserId: user.id,
      tier: KiloPassTier.Tier19,
      cadence: KiloPassCadence.Monthly,
    });
    const subscription = makeStripeSubscription({
      id: stripeSubId,
      start_date_seconds: 1_735_689_600,
      metadata: meta,
    });

    const retrieve = jest.fn(async () => subscription);
    const stripe = {
      subscriptions: {
        retrieve,
      },
    };

    // Seed an earlier month issuance for this subscription so the handler computes a 2-month streak.
    // We can't insert issuances before the subscription exists, so insert a minimal subscription row first.
    const inserted = await db
      .insert(kilo_pass_subscriptions)
      .values({
        kilo_user_id: user.id,
        stripe_subscription_id: stripeSubId,
        tier: KiloPassTier.Tier19,
        cadence: KiloPassCadence.Monthly,
        status: 'active',
        started_at: new Date(subscription.start_date * 1000).toISOString(),
        ended_at: null,
        current_streak_months: 1,
      })
      .returning({ subscriptionId: kilo_pass_subscriptions.id });

    const subscriptionId = inserted[0]?.subscriptionId;
    expect(subscriptionId).toBeTruthy();
    if (!subscriptionId) throw new Error('Failed to insert kilo_pass_subscriptions row');

    await db.insert(kilo_pass_issuances).values({
      kilo_pass_subscription_id: subscriptionId,
      issue_month: '2025-12-01',
      source: KiloPassIssuanceSource.Cron,
      stripe_invoice_id: null,
    });

    const priceId = await getKiloPassPriceId({
      tier: KiloPassTier.Tier19,
      cadence: KiloPassCadence.Monthly,
    });
    const invoiceId = `inv_streak_${Math.random()}`;
    const invoice = makeStripeInvoice({
      id: invoiceId,
      amount_paid_cents: 1900,
      period_start_seconds: 1_767_225_600, // 2026-01-01T00:00:00Z
      created_seconds: 1_767_225_600,
      priceId,
      subscriptionIdOrExpanded: stripeSubId,
      metadata: meta,
    });

    await handleKiloPassInvoicePaid({
      eventId: 'evt_test_5',
      invoice,
      stripe: stripe as unknown as Stripe,
    });

    const updatedSub = await db.query.kilo_pass_subscriptions.findFirst({
      where: eq(kilo_pass_subscriptions.id, subscriptionId),
    });
    expect(updatedSub?.current_streak_months).toBe(2);

    const issuance = await db.query.kilo_pass_issuances.findFirst({
      where: eq(kilo_pass_issuances.stripe_invoice_id, invoiceId),
    });
    expect(issuance).toBeTruthy();

    const issuanceItemKinds = await db
      .select({ kind: kilo_pass_issuance_items.kind })
      .from(kilo_pass_issuance_items)
      .where(eq(kilo_pass_issuance_items.kilo_pass_issuance_id, issuance?.id ?? ''));
    expect(issuanceItemKinds.map(i => i.kind).sort()).toEqual([KiloPassIssuanceItemKind.Base]);
  });

  test('yearly: first invoice issues base credits (bonus is issued later on usage); retry is idempotent', async () => {
    const { handleKiloPassInvoicePaid } =
      await import('@/lib/kilo-pass/stripe-handlers-invoice-paid');

    const user = await insertTestUser({
      total_microdollars_acquired: 0,
      microdollars_used: 3_000_000,
    });
    const stripeSubId = `sub_${Math.random()}`;

    const meta = kiloPassMetadata({
      kiloUserId: user.id,
      tier: KiloPassTier.Tier49,
      cadence: KiloPassCadence.Yearly,
    });
    const subscription = makeStripeSubscription({
      id: stripeSubId,
      start_date_seconds: 1_767_225_600,
      metadata: meta,
    });

    const retrieve = jest.fn(async () => subscription);
    const stripe = {
      subscriptions: {
        retrieve,
      },
    };

    const priceId = await getKiloPassPriceId({
      tier: KiloPassTier.Tier49,
      cadence: KiloPassCadence.Yearly,
    });
    const invoiceId = `inv_yearly_${Math.random()}`;
    const invoicePaymentId = `inpay_${Math.random()}`;
    const invoice = makeStripeInvoice({
      id: invoiceId,
      // Intentionally not equal to the tier-config amount (e.g. taxes/discounts/proration).
      // The handler should still use tier-config pricing for threshold updates.
      amount_paid_cents: 1234,
      period_start_seconds: 1_767_225_600, // 2026-01-01T00:00:00Z
      created_seconds: 1_767_225_600,
      paid_seconds: 1_767_830_400, // 2026-01-08T00:00:00Z
      priceId,
      subscriptionIdOrExpanded: stripeSubId,
      metadata: meta,
      invoicePaymentId,
    });

    await handleKiloPassInvoicePaid({
      eventId: 'evt_test_7',
      invoice,
      stripe: stripe as unknown as Stripe,
    });

    // Simulate webhook retry: should not double-issue base or bonus.
    await handleKiloPassInvoicePaid({
      eventId: 'evt_test_7_retry',
      invoice,
      stripe: stripe as unknown as Stripe,
    });

    const userRow = await db.query.kilocode_users.findFirst({
      where: eq(kilocode_users.id, user.id),
    });
    expect(userRow?.kilo_pass_threshold).toBe(3_000_000 + 4_900 * 10_000);

    const subRow = await db.query.kilo_pass_subscriptions.findFirst({
      where: eq(kilo_pass_subscriptions.stripe_subscription_id, stripeSubId),
    });
    expect(subRow).toBeTruthy();
    expect(subRow?.cadence).toBe(KiloPassCadence.Yearly);
    expect(subRow?.status).toBe('active');

    const nextYearlyIssueAt = subRow?.next_yearly_issue_at;
    expect(nextYearlyIssueAt).toBeTruthy();
    if (!nextYearlyIssueAt) throw new Error('Expected next_yearly_issue_at to be set');
    expect(new Date(nextYearlyIssueAt).toISOString()).toBe('2026-02-08T00:00:00.000Z');

    const issuance = await db.query.kilo_pass_issuances.findFirst({
      where: eq(kilo_pass_issuances.stripe_invoice_id, invoiceId),
    });
    expect(issuance).toBeTruthy();

    const kinds = await db
      .select({ kind: kilo_pass_issuance_items.kind })
      .from(kilo_pass_issuance_items)
      .where(eq(kilo_pass_issuance_items.kilo_pass_issuance_id, issuance?.id ?? ''));

    expect(kinds.map(k => k.kind).sort()).toEqual([KiloPassIssuanceItemKind.Base]);

    const baseTx = await db
      .select({
        isFree: credit_transactions.is_free,
        amountMicrodollars: credit_transactions.amount_microdollars,
        stripePaymentId: credit_transactions.stripe_payment_id,
      })
      .from(credit_transactions)
      .where(
        and(
          eq(credit_transactions.kilo_user_id, user.id),
          eq(credit_transactions.description, 'Kilo Pass base credits (tier_49, yearly)')
        )
      );
    expect(baseTx).toHaveLength(1);
    expect(baseTx[0]?.isFree).toBe(false);
    expect(baseTx[0]?.amountMicrodollars).toBe(49_000_000);
    // We treat the Stripe invoice ID as the canonical paid-credit idempotency key.
    expect(baseTx[0]?.stripePaymentId).toBe(invoiceId);
  });

  test('yearly: yearly→yearly tier upgrade issues remaining base credits within the current yearly cycle and releases the schedule', async () => {
    const { handleKiloPassInvoicePaid } =
      await import('@/lib/kilo-pass/stripe-handlers-invoice-paid');

    const user = await insertTestUser({ total_microdollars_acquired: 0, microdollars_used: 0 });

    const stripeSubId = `sub_${Math.random()}`;
    const stripeScheduleId = `sched_${Math.random()}`;
    const scheduledChangeId = randomUUID();

    const startedAt = '2024-01-01T00:00:00.000Z';
    // 2025-04-01 is 15 months after 2024-01-01. Remaining months should be 12 - (15 % 12) = 9.
    const effectiveAt = '2025-04-01T00:00:00.000Z';

    await db.insert(kilo_pass_subscriptions).values({
      kilo_user_id: user.id,
      stripe_subscription_id: stripeSubId,
      tier: KiloPassTier.Tier19,
      cadence: KiloPassCadence.Yearly,
      status: 'active',
      cancel_at_period_end: false,
      started_at: startedAt,
      ended_at: null,
      current_streak_months: 0,
      next_yearly_issue_at: '2024-02-01T00:00:00.000Z',
    });

    await db.insert(kilo_pass_scheduled_changes).values({
      id: scheduledChangeId,
      kilo_user_id: user.id,
      stripe_subscription_id: stripeSubId,
      from_tier: KiloPassTier.Tier19,
      from_cadence: KiloPassCadence.Yearly,
      to_tier: KiloPassTier.Tier49,
      to_cadence: KiloPassCadence.Yearly,
      stripe_schedule_id: stripeScheduleId,
      effective_at: effectiveAt,
      status: KiloPassScheduledChangeStatus.NotStarted,
    });

    const meta = kiloPassMetadata({
      kiloUserId: user.id,
      tier: KiloPassTier.Tier49,
      cadence: KiloPassCadence.Yearly,
      kiloPassScheduledChangeId: scheduledChangeId,
    });

    const subscription = makeStripeSubscription({
      id: stripeSubId,
      start_date_seconds: 1_704_067_200, // 2024-01-01T00:00:00Z
      metadata: meta,
    });

    const retrieve = jest.fn(async () => subscription);
    const release = jest.fn(async (_scheduleId: string) => ({}));
    const stripe = {
      subscriptions: {
        retrieve,
      },
      subscriptionSchedules: {
        release,
      },
    };

    const priceId = await getKiloPassPriceId({
      tier: KiloPassTier.Tier49,
      cadence: KiloPassCadence.Yearly,
    });

    const invoiceId = `inv_yearly_upgrade_${Math.random()}`;
    const invoice = makeStripeInvoice({
      id: invoiceId,
      amount_paid_cents: 49_00 * 12,
      period_start_seconds: 1_743_465_600, // 2025-04-01T00:00:00Z
      created_seconds: 1_743_465_600,
      paid_seconds: 1_743_552_000, // 2025-04-02T00:00:00Z
      priceId,
      subscriptionIdOrExpanded: stripeSubId,
      metadata: meta,
    });

    await handleKiloPassInvoicePaid({
      eventId: 'evt_test_yearly_upgrade',
      invoice,
      stripe: stripe as unknown as Stripe,
    });

    expect(release).toHaveBeenCalledWith(stripeScheduleId);

    const scheduledChangeRow = await db.query.kilo_pass_scheduled_changes.findFirst({
      where: eq(kilo_pass_scheduled_changes.id, scheduledChangeId),
    });
    expect(scheduledChangeRow).toBeTruthy();
    expect(scheduledChangeRow?.status).toBe(KiloPassScheduledChangeStatus.Released);
    expect(scheduledChangeRow?.deleted_at).not.toBeNull();

    const syntheticInvoiceId = `kilo-pass-yearly-remaining:${scheduledChangeId}`;
    const remainingTx = await db.query.credit_transactions.findFirst({
      where: eq(credit_transactions.stripe_payment_id, syntheticInvoiceId),
    });
    expect(remainingTx).toBeTruthy();
    expect(remainingTx?.amount_microdollars).toBe(171_000_000);

    const remainingAuditLog = await db.query.kilo_pass_audit_log.findFirst({
      where: eq(kilo_pass_audit_log.stripe_invoice_id, syntheticInvoiceId),
    });
    expect(remainingAuditLog?.action).toBe(KiloPassAuditLogAction.IssueYearlyRemainingCredits);
    expect(remainingAuditLog?.stripe_event_id).toBe('evt_test_yearly_upgrade');
    expect(remainingAuditLog?.payload_json).toEqual(
      expect.objectContaining({
        triggeringStripeInvoiceId: invoiceId,
        remainingMonths: 9,
      })
    );
  });

  test('monthly: tier_49→tier_199 upgrade issues tier_199 base credits and deletes the scheduled change when the new invoice is paid', async () => {
    const { handleKiloPassInvoicePaid } =
      await import('@/lib/kilo-pass/stripe-handlers-invoice-paid');

    const user = await insertTestUser({ total_microdollars_acquired: 0, microdollars_used: 0 });

    const stripeSubId = `sub_${Math.random()}`;
    const stripeScheduleId = `sched_${Math.random()}`;
    const scheduledChangeId = randomUUID();

    await db.insert(kilo_pass_subscriptions).values({
      kilo_user_id: user.id,
      stripe_subscription_id: stripeSubId,
      tier: KiloPassTier.Tier49,
      cadence: KiloPassCadence.Monthly,
      status: 'active',
      cancel_at_period_end: false,
      started_at: '2025-12-01T00:00:00.000Z',
      ended_at: null,
      current_streak_months: 1,
      next_yearly_issue_at: null,
    });

    await db.insert(kilo_pass_scheduled_changes).values({
      id: scheduledChangeId,
      kilo_user_id: user.id,
      stripe_subscription_id: stripeSubId,
      from_tier: KiloPassTier.Tier49,
      from_cadence: KiloPassCadence.Monthly,
      to_tier: KiloPassTier.Tier199,
      to_cadence: KiloPassCadence.Monthly,
      stripe_schedule_id: stripeScheduleId,
      effective_at: '2026-01-01T00:00:00.000Z',
      status: KiloPassScheduledChangeStatus.NotStarted,
    });

    const meta = kiloPassMetadata({
      kiloUserId: user.id,
      tier: KiloPassTier.Tier199,
      cadence: KiloPassCadence.Monthly,
      kiloPassScheduledChangeId: scheduledChangeId,
    });

    const subscription = makeStripeSubscription({
      id: stripeSubId,
      start_date_seconds: 1_764_342_400, // 2025-12-01T00:00:00Z
      metadata: meta,
    });

    const retrieve = jest.fn(async () => subscription);
    const release = jest.fn(async (_scheduleId: string) => ({}));
    const stripe = {
      subscriptions: { retrieve },
      subscriptionSchedules: { release },
    };

    const priceId = await getKiloPassPriceId({
      tier: KiloPassTier.Tier199,
      cadence: KiloPassCadence.Monthly,
    });
    const invoiceId = `inv_monthly_upgrade_${Math.random()}`;
    const invoicePaymentId = `inpay_${Math.random()}`;
    const invoice = makeStripeInvoice({
      id: invoiceId,
      amount_paid_cents: 19900,
      period_start_seconds: 1_767_225_600, // 2026-01-01T00:00:00Z
      created_seconds: 1_767_225_600,
      priceId,
      subscriptionIdOrExpanded: stripeSubId,
      metadata: meta,
      invoicePaymentId,
    });

    await handleKiloPassInvoicePaid({
      eventId: 'evt_test_monthly_upgrade',
      invoice,
      stripe: stripe as unknown as Stripe,
    });

    expect(release).toHaveBeenCalledWith(stripeScheduleId);

    const scheduledChangeRow = await db.query.kilo_pass_scheduled_changes.findFirst({
      where: eq(kilo_pass_scheduled_changes.id, scheduledChangeId),
    });
    expect(scheduledChangeRow).toBeTruthy();
    expect(scheduledChangeRow?.status).toBe(KiloPassScheduledChangeStatus.Released);
    expect(scheduledChangeRow?.deleted_at).not.toBeNull();

    const baseTx = await db
      .select({
        isFree: credit_transactions.is_free,
        amountMicrodollars: credit_transactions.amount_microdollars,
        stripePaymentId: credit_transactions.stripe_payment_id,
      })
      .from(credit_transactions)
      .where(
        and(
          eq(credit_transactions.kilo_user_id, user.id),
          eq(credit_transactions.description, 'Kilo Pass base credits (tier_199, monthly)')
        )
      );

    expect(baseTx).toHaveLength(1);
    expect(baseTx[0]?.isFree).toBe(false);
    expect(baseTx[0]?.amountMicrodollars).toBe(199_000_000);
    // We treat the Stripe invoice ID as the canonical paid-credit idempotency key.
    expect(baseTx[0]?.stripePaymentId).toBe(invoiceId);
  });

  test('out-of-order invoice.paid does not resurrect a canceled subscription (regression)', async () => {
    const { handleKiloPassInvoicePaid } =
      await import('@/lib/kilo-pass/stripe-handlers-invoice-paid');

    const user = await insertTestUser({ total_microdollars_acquired: 0, microdollars_used: 0 });
    const stripeSubId = `sub_${Math.random()}`;

    // Pre-seed a canceled subscription row (simulating subscription was canceled after invoice was created)
    const canceledAt = 1_767_312_000; // 2026-01-02T00:00:00Z
    await db.insert(kilo_pass_subscriptions).values({
      kilo_user_id: user.id,
      stripe_subscription_id: stripeSubId,
      tier: KiloPassTier.Tier19,
      cadence: KiloPassCadence.Monthly,
      status: 'canceled',
      started_at: new Date(1_735_689_600 * 1000).toISOString(),
      ended_at: new Date(canceledAt * 1000).toISOString(),
      current_streak_months: 1,
    });

    const meta = kiloPassMetadata({
      kiloUserId: user.id,
      tier: KiloPassTier.Tier19,
      cadence: KiloPassCadence.Monthly,
    });

    // Stripe API returns the current (canceled) state of the subscription
    const subscription = makeStripeSubscription({
      id: stripeSubId,
      start_date_seconds: 1_735_689_600,
      metadata: meta,
      status: 'canceled',
      ended_at: canceledAt,
      canceled_at: canceledAt,
    });

    const retrieve = jest.fn(async () => subscription);
    const stripe = {
      subscriptions: {
        retrieve,
      },
    };

    const invoiceId = `inv_out_of_order_${Math.random()}`;
    const priceId = await getKiloPassPriceId({
      tier: KiloPassTier.Tier19,
      cadence: KiloPassCadence.Monthly,
    });
    // Invoice from before the cancellation
    const invoice = makeStripeInvoice({
      id: invoiceId,
      amount_paid_cents: 1900,
      period_start_seconds: 1_767_225_600, // 2026-01-01T00:00:00Z (before cancellation)
      created_seconds: 1_767_225_600,
      priceId,
      subscriptionIdOrExpanded: stripeSubId,
      metadata: meta,
    });

    await handleKiloPassInvoicePaid({
      eventId: 'evt_out_of_order',
      invoice,
      stripe: stripe as unknown as Stripe,
    });

    // Verify the subscription row was NOT resurrected to 'active'
    const subRow = await db.query.kilo_pass_subscriptions.findFirst({
      where: eq(kilo_pass_subscriptions.stripe_subscription_id, stripeSubId),
    });
    expect(subRow).toBeTruthy();
    expect(subRow?.status).toBe('canceled');
    expect(subRow?.ended_at).not.toBeNull();
  });
});
