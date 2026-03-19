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

async function seedBaseIssuance(params: {
  subscriptionId: string;
  kiloUserId: string;
  issueMonth: string;
  amountUsd: number;
}): Promise<void> {
  const [creditTxn] = await db
    .insert(credit_transactions)
    .values({
      id: randomUUID(),
      kilo_user_id: params.kiloUserId,
      amount_microdollars: params.amountUsd * 1_000_000,
      is_free: false,
      description: `seed-issuance-${params.issueMonth}`,
    })
    .returning({ id: credit_transactions.id });
  if (!creditTxn) throw new Error('Failed to insert seed credit transaction');

  const [issuance] = await db
    .insert(kilo_pass_issuances)
    .values({
      kilo_pass_subscription_id: params.subscriptionId,
      issue_month: params.issueMonth,
      source: KiloPassIssuanceSource.StripeInvoice,
      stripe_invoice_id: `in_seed_${params.issueMonth}_${Math.random()}`,
    })
    .returning({ id: kilo_pass_issuances.id });
  if (!issuance) throw new Error(`Failed to insert seed issuance for ${params.issueMonth}`);

  await db.insert(kilo_pass_issuance_items).values({
    kilo_pass_issuance_id: issuance.id,
    kind: KiloPassIssuanceItemKind.Base,
    credit_transaction_id: creditTxn.id,
    amount_usd: params.amountUsd,
    bonus_percent_applied: null,
  });
}

function makeInvoicesListMock(params: {
  yearlyPeriodStartSeconds: number;
  yearlyPeriodEndSeconds: number;
}): ReturnType<typeof jest.fn> {
  return jest.fn(async () => ({
    data: [
      {
        id: `in_mock_yearly_${Math.random()}`,
        lines: {
          data: [
            {
              period: {
                start: params.yearlyPeriodStartSeconds,
                end: params.yearlyPeriodEndSeconds,
              },
            },
          ],
        },
      },
    ],
  }));
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
    // Yearly cycle #2 started Jan 2025. By Apr 2025 (effectiveAt), 3 months of
    // credits were issued (Jan, Feb, Mar). Remaining should be 12 - 3 = 9.
    const effectiveAt = '2025-04-01T00:00:00.000Z';

    const [sub] = await db
      .insert(kilo_pass_subscriptions)
      .values({
        kilo_user_id: user.id,
        stripe_subscription_id: stripeSubId,
        tier: KiloPassTier.Tier19,
        cadence: KiloPassCadence.Yearly,
        status: 'active',
        cancel_at_period_end: false,
        started_at: startedAt,
        ended_at: null,
        current_streak_months: 0,
        next_yearly_issue_at: '2025-04-01T00:00:00.000Z',
      })
      .returning({ id: kilo_pass_subscriptions.id });
    if (!sub) throw new Error('Failed to insert subscription');

    // Seed 3 monthly issuances in the current yearly cycle (Jan, Feb, Mar 2025)
    for (const month of ['2025-01-01', '2025-02-01', '2025-03-01']) {
      await seedBaseIssuance({
        subscriptionId: sub.id,
        kiloUserId: user.id,
        issueMonth: month,
        amountUsd: 19,
      });
    }

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
    // Yearly cycle started Jan 1 2025 (second year of subscription).
    const list = makeInvoicesListMock({
      yearlyPeriodStartSeconds: 1_735_689_600, // 2025-01-01T00:00:00Z
      yearlyPeriodEndSeconds: 1_767_225_600, // 2026-01-01T00:00:00Z
    });
    const stripe = {
      subscriptions: {
        retrieve,
      },
      subscriptionSchedules: {
        release,
      },
      invoices: {
        list,
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

  test('yearly: upgrade invoice appearing in invoices.list does not match as the billing cycle invoice (regression #1274)', async () => {
    // Stripe returns invoices newest-first from invoices.list. When a yearly
    // upgrade invoice is paid, Stripe may return it in the list alongside the
    // original yearly invoice. The upgrade invoice's period also contains the
    // effective date, so without filtering it out, the code would incorrectly
    // use the upgrade invoice's period to compute months elapsed — yielding 0
    // months used and over-issuing remaining credits.
    const { handleKiloPassInvoicePaid } =
      await import('@/lib/kilo-pass/stripe-handlers-invoice-paid');

    const user = await insertTestUser({ total_microdollars_acquired: 0, microdollars_used: 0 });

    const stripeSubId = `sub_${Math.random()}`;
    const stripeScheduleId = `sched_${Math.random()}`;
    const scheduledChangeId = randomUUID();

    const startedAt = '2024-01-01T00:00:00.000Z';
    const effectiveAt = '2025-04-01T00:00:00.000Z';

    const [sub] = await db
      .insert(kilo_pass_subscriptions)
      .values({
        kilo_user_id: user.id,
        stripe_subscription_id: stripeSubId,
        tier: KiloPassTier.Tier19,
        cadence: KiloPassCadence.Yearly,
        status: 'active',
        cancel_at_period_end: false,
        started_at: startedAt,
        ended_at: null,
        current_streak_months: 0,
        next_yearly_issue_at: '2025-04-01T00:00:00.000Z',
      })
      .returning({ id: kilo_pass_subscriptions.id });
    if (!sub) throw new Error('Failed to insert subscription');

    for (const month of ['2025-01-01', '2025-02-01', '2025-03-01']) {
      await seedBaseIssuance({
        subscriptionId: sub.id,
        kiloUserId: user.id,
        issueMonth: month,
        amountUsd: 19,
      });
    }

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

    const invoiceId = `inv_yearly_upgrade_regression_${Math.random()}`;

    // Simulate real Stripe behavior: invoices.list returns the upgrade invoice
    // (newest) BEFORE the original yearly invoice. Both periods contain the
    // effective date.
    const upgradeInvoicePeriodStart = 1_743_465_600; // 2025-04-01 (upgrade start)
    const upgradeInvoicePeriodEnd = 1_775_001_600; // 2026-04-01
    const originalYearlyPeriodStart = 1_735_689_600; // 2025-01-01
    const originalYearlyPeriodEnd = 1_767_225_600; // 2026-01-01

    const list = jest.fn(async () => ({
      data: [
        // Newest first — the upgrade invoice itself
        {
          id: invoiceId,
          lines: {
            data: [
              {
                period: {
                  start: upgradeInvoicePeriodStart,
                  end: upgradeInvoicePeriodEnd,
                },
              },
            ],
          },
        },
        // Original yearly invoice
        {
          id: `in_original_yearly_${Math.random()}`,
          lines: {
            data: [
              {
                period: {
                  start: originalYearlyPeriodStart,
                  end: originalYearlyPeriodEnd,
                },
              },
            ],
          },
        },
      ],
    }));

    const retrieve = jest.fn(async () => subscription);
    const release = jest.fn(async (_scheduleId: string) => ({}));
    const stripe = {
      subscriptions: { retrieve },
      subscriptionSchedules: { release },
      invoices: { list },
    };

    const priceId = await getKiloPassPriceId({
      tier: KiloPassTier.Tier49,
      cadence: KiloPassCadence.Yearly,
    });

    const invoice = makeStripeInvoice({
      id: invoiceId,
      amount_paid_cents: 49_00 * 12,
      period_start_seconds: upgradeInvoicePeriodStart,
      created_seconds: upgradeInvoicePeriodStart,
      paid_seconds: upgradeInvoicePeriodStart + 3600,
      priceId,
      subscriptionIdOrExpanded: stripeSubId,
      metadata: meta,
    });

    await handleKiloPassInvoicePaid({
      eventId: 'evt_test_yearly_upgrade_regression_1274',
      invoice,
      stripe: stripe as unknown as Stripe,
    });

    const syntheticInvoiceId = `kilo-pass-yearly-remaining:${scheduledChangeId}`;
    const remainingTx = await db.query.credit_transactions.findFirst({
      where: eq(credit_transactions.stripe_payment_id, syntheticInvoiceId),
    });
    expect(remainingTx).toBeTruthy();
    // 3 months used (Jan, Feb, Mar). 9 remaining × $19 = $171.
    // Without the fix, the upgrade invoice would match first, yielding 0 months
    // elapsed and 12 remaining × $19 = $228 (wrong).
    expect(remainingTx?.amount_microdollars).toBe(171_000_000);

    const remainingAuditLog = await db.query.kilo_pass_audit_log.findFirst({
      where: eq(kilo_pass_audit_log.stripe_invoice_id, syntheticInvoiceId),
    });
    expect(remainingAuditLog?.payload_json).toEqual(
      expect.objectContaining({
        remainingMonths: 9,
      })
    );
  });

  test('yearly: remaining credits use invoice billing period, not started_at, after a prior cadence change', async () => {
    // Scenario: subscription started monthly on Mar 1, switched to yearly on Apr 1
    // (billing_cycle_anchor: phase_start reset the billing cycle). Then user uptiers
    // on May 1 — only 1 month into the yearly cycle. The handler should issue 11
    // remaining months, not fewer (which would happen if it used started_at to compute
    // months elapsed).
    const { handleKiloPassInvoicePaid } =
      await import('@/lib/kilo-pass/stripe-handlers-invoice-paid');

    const user = await insertTestUser({ total_microdollars_acquired: 0, microdollars_used: 0 });

    const stripeSubId = `sub_${Math.random()}`;
    const stripeScheduleId = `sched_${Math.random()}`;
    const scheduledChangeId = randomUUID();

    // started_at is the ORIGINAL subscription start (when it was monthly).
    // The yearly billing cycle actually started Apr 1 (after cadence change with
    // billing_cycle_anchor: phase_start).
    const startedAt = '2025-03-01T00:00:00.000Z';
    const effectiveAt = '2025-05-01T00:00:00.000Z';
    // The yearly billing period runs Apr 1 2025 → Apr 1 2026.
    const yearlyBillingPeriodStartSeconds = 1_743_465_600; // 2025-04-01T00:00:00Z
    const yearlyBillingPeriodEndSeconds = 1_775_001_600; // 2026-04-01T00:00:00Z

    const [sub] = await db
      .insert(kilo_pass_subscriptions)
      .values({
        kilo_user_id: user.id,
        stripe_subscription_id: stripeSubId,
        tier: KiloPassTier.Tier19,
        cadence: KiloPassCadence.Yearly,
        status: 'active',
        cancel_at_period_end: false,
        started_at: startedAt,
        ended_at: null,
        current_streak_months: 0,
        next_yearly_issue_at: '2025-05-01T00:00:00.000Z',
      })
      .returning({ id: kilo_pass_subscriptions.id });
    if (!sub) throw new Error('Failed to insert subscription');

    // Seed 1 monthly issuance in the current yearly cycle (Apr 2025)
    await seedBaseIssuance({
      subscriptionId: sub.id,
      kiloUserId: user.id,
      issueMonth: '2025-04-01',
      amountUsd: 19,
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
      start_date_seconds: 1_740_787_200, // 2025-03-01T00:00:00Z (original start)
      metadata: meta,
    });

    const retrieve = jest.fn(async () => subscription);
    const release = jest.fn(async (_scheduleId: string) => ({}));
    // Yearly cycle started Apr 1 2025 (after cadence change from monthly).
    const list = makeInvoicesListMock({
      yearlyPeriodStartSeconds: yearlyBillingPeriodStartSeconds,
      yearlyPeriodEndSeconds: yearlyBillingPeriodEndSeconds,
    });
    const stripe = {
      subscriptions: { retrieve },
      subscriptionSchedules: { release },
      invoices: { list },
    };

    const priceId = await getKiloPassPriceId({
      tier: KiloPassTier.Tier49,
      cadence: KiloPassCadence.Yearly,
    });

    const invoiceId = `inv_yearly_upgrade_after_cadence_change_${Math.random()}`;
    const invoice = makeStripeInvoice({
      id: invoiceId,
      amount_paid_cents: 49_00 * 12,
      period_start_seconds: yearlyBillingPeriodEndSeconds, // Stripe sets period_start to the new period
      created_seconds: 1_746_057_600, // 2025-05-01T00:00:00Z
      paid_seconds: 1_746_057_600,
      priceId,
      subscriptionIdOrExpanded: stripeSubId,
      metadata: meta,
    });

    await handleKiloPassInvoicePaid({
      eventId: 'evt_test_yearly_upgrade_after_cadence_change',
      invoice,
      stripe: stripe as unknown as Stripe,
    });

    const syntheticInvoiceId = `kilo-pass-yearly-remaining:${scheduledChangeId}`;
    const remainingTx = await db.query.credit_transactions.findFirst({
      where: eq(credit_transactions.stripe_payment_id, syntheticInvoiceId),
    });
    expect(remainingTx).toBeTruthy();
    // Only 1 month was used (Apr). 11 remaining × $19 = $209.
    expect(remainingTx?.amount_microdollars).toBe(209_000_000);

    const remainingAuditLog = await db.query.kilo_pass_audit_log.findFirst({
      where: eq(kilo_pass_audit_log.stripe_invoice_id, syntheticInvoiceId),
    });
    expect(remainingAuditLog?.payload_json).toEqual(
      expect.objectContaining({
        remainingMonths: 11,
      })
    );
  });

  test('yearly: prior monthly issuances outside the 12-month window do not inflate remaining credits', async () => {
    // Scenario: user subscribes monthly for 2 months (Jan–Feb 2025), cancels,
    // comes back 4 months later and subscribes yearly (Jul 2025). After 2 months
    // of yearly credits (Jul, Aug), they uptier in Sep 2025.
    // The old monthly issuances (Jan, Feb) should NOT count — only the 2 yearly
    // issuances matter. Remaining = 12 - 2 = 10.
    const { handleKiloPassInvoicePaid } =
      await import('@/lib/kilo-pass/stripe-handlers-invoice-paid');

    const user = await insertTestUser({ total_microdollars_acquired: 0, microdollars_used: 0 });

    const stripeSubId = `sub_${Math.random()}`;
    const stripeScheduleId = `sched_${Math.random()}`;
    const scheduledChangeId = randomUUID();

    const startedAt = '2025-01-01T00:00:00.000Z';
    const effectiveAt = '2025-09-01T00:00:00.000Z';

    const [sub] = await db
      .insert(kilo_pass_subscriptions)
      .values({
        kilo_user_id: user.id,
        stripe_subscription_id: stripeSubId,
        tier: KiloPassTier.Tier19,
        cadence: KiloPassCadence.Yearly,
        status: 'active',
        cancel_at_period_end: false,
        started_at: startedAt,
        ended_at: null,
        current_streak_months: 0,
        next_yearly_issue_at: '2025-09-01T00:00:00.000Z',
      })
      .returning({ id: kilo_pass_subscriptions.id });
    if (!sub) throw new Error('Failed to insert subscription');

    // Old monthly issuances from before the gap — should not affect remaining
    // credits since the Stripe invoice period anchors the yearly cycle to Jul 2025.
    for (const month of ['2025-01-01', '2025-02-01']) {
      await seedBaseIssuance({
        subscriptionId: sub.id,
        kiloUserId: user.id,
        issueMonth: month,
        amountUsd: 19,
      });
    }

    // Yearly issuances (Jul, Aug 2025)
    for (const month of ['2025-07-01', '2025-08-01']) {
      await seedBaseIssuance({
        subscriptionId: sub.id,
        kiloUserId: user.id,
        issueMonth: month,
        amountUsd: 19,
      });
    }

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
      start_date_seconds: 1_735_689_600, // 2025-01-01T00:00:00Z
      metadata: meta,
    });

    const retrieve = jest.fn(async () => subscription);
    const release = jest.fn(async (_scheduleId: string) => ({}));
    // Yearly cycle started Jul 1 2025 (after gap and re-subscription).
    const list = makeInvoicesListMock({
      yearlyPeriodStartSeconds: 1_751_328_000, // 2025-07-01T00:00:00Z
      yearlyPeriodEndSeconds: 1_782_864_000, // 2026-07-01T00:00:00Z
    });
    const stripe = {
      subscriptions: { retrieve },
      subscriptionSchedules: { release },
      invoices: { list },
    };

    const priceId = await getKiloPassPriceId({
      tier: KiloPassTier.Tier49,
      cadence: KiloPassCadence.Yearly,
    });

    const invoiceId = `inv_yearly_upgrade_with_gap_${Math.random()}`;
    const invoice = makeStripeInvoice({
      id: invoiceId,
      amount_paid_cents: 49_00 * 12,
      period_start_seconds: 1_756_684_800, // 2025-09-01T00:00:00Z
      created_seconds: 1_756_684_800,
      paid_seconds: 1_756_684_800,
      priceId,
      subscriptionIdOrExpanded: stripeSubId,
      metadata: meta,
    });

    await handleKiloPassInvoicePaid({
      eventId: 'evt_test_yearly_upgrade_with_gap',
      invoice,
      stripe: stripe as unknown as Stripe,
    });

    const syntheticInvoiceId = `kilo-pass-yearly-remaining:${scheduledChangeId}`;
    const remainingTx = await db.query.credit_transactions.findFirst({
      where: eq(credit_transactions.stripe_payment_id, syntheticInvoiceId),
    });
    expect(remainingTx).toBeTruthy();
    // Only 2 yearly months used (Jul, Aug). 10 remaining × $19 = $190.
    // The old monthly issuances (Jan, Feb) must NOT count.
    expect(remainingTx?.amount_microdollars).toBe(190_000_000);

    const remainingAuditLog = await db.query.kilo_pass_audit_log.findFirst({
      where: eq(kilo_pass_audit_log.stripe_invoice_id, syntheticInvoiceId),
    });
    expect(remainingAuditLog?.payload_json).toEqual(
      expect.objectContaining({
        remainingMonths: 10,
      })
    );
  });

  test('yearly: upgrade at exactly month 12 (full year used) issues 0 remaining credits', async () => {
    // User has used all 12 months of their yearly cycle. Upgrading at the cycle
    // boundary should not issue any remaining credits.
    const { handleKiloPassInvoicePaid } =
      await import('@/lib/kilo-pass/stripe-handlers-invoice-paid');

    const user = await insertTestUser({ total_microdollars_acquired: 0, microdollars_used: 0 });

    const stripeSubId = `sub_${Math.random()}`;
    const stripeScheduleId = `sched_${Math.random()}`;
    const scheduledChangeId = randomUUID();

    const startedAt = '2024-01-01T00:00:00.000Z';
    // effectiveAt = exactly 12 months after cycle start
    const effectiveAt = '2025-01-01T00:00:00.000Z';

    const [sub] = await db
      .insert(kilo_pass_subscriptions)
      .values({
        kilo_user_id: user.id,
        stripe_subscription_id: stripeSubId,
        tier: KiloPassTier.Tier19,
        cadence: KiloPassCadence.Yearly,
        status: 'active',
        cancel_at_period_end: false,
        started_at: startedAt,
        ended_at: null,
        current_streak_months: 0,
        next_yearly_issue_at: '2025-01-01T00:00:00.000Z',
      })
      .returning({ id: kilo_pass_subscriptions.id });
    if (!sub) throw new Error('Failed to insert subscription');

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
      start_date_seconds: 1_704_067_200, // 2024-01-01
      metadata: meta,
    });

    const retrieve = jest.fn(async () => subscription);
    const release = jest.fn(async (_scheduleId: string) => ({}));
    // Yearly cycle ran Jan 2024 → Jan 2025. Effective = Jan 2025 = cycle end.
    const list = makeInvoicesListMock({
      yearlyPeriodStartSeconds: 1_704_067_200, // 2024-01-01
      yearlyPeriodEndSeconds: 1_735_689_600, // 2025-01-01
    });
    const stripe = {
      subscriptions: { retrieve },
      subscriptionSchedules: { release },
      invoices: { list },
    };

    const priceId = await getKiloPassPriceId({
      tier: KiloPassTier.Tier49,
      cadence: KiloPassCadence.Yearly,
    });

    const invoiceId = `inv_yearly_upgrade_at_boundary_${Math.random()}`;
    const invoice = makeStripeInvoice({
      id: invoiceId,
      amount_paid_cents: 49_00 * 12,
      period_start_seconds: 1_735_689_600, // 2025-01-01
      created_seconds: 1_735_689_600,
      paid_seconds: 1_735_689_600,
      priceId,
      subscriptionIdOrExpanded: stripeSubId,
      metadata: meta,
    });

    await handleKiloPassInvoicePaid({
      eventId: 'evt_test_yearly_upgrade_at_boundary',
      invoice,
      stripe: stripe as unknown as Stripe,
    });

    // No remaining credits should be issued — full year was used.
    const syntheticInvoiceId = `kilo-pass-yearly-remaining:${scheduledChangeId}`;
    const remainingTx = await db.query.credit_transactions.findFirst({
      where: eq(credit_transactions.stripe_payment_id, syntheticInvoiceId),
    });
    expect(remainingTx).toBeUndefined();
  });

  test('yearly: upgrade at month 1 (just started yearly) issues 11 remaining months', async () => {
    const { handleKiloPassInvoicePaid } =
      await import('@/lib/kilo-pass/stripe-handlers-invoice-paid');

    const user = await insertTestUser({ total_microdollars_acquired: 0, microdollars_used: 0 });

    const stripeSubId = `sub_${Math.random()}`;
    const stripeScheduleId = `sched_${Math.random()}`;
    const scheduledChangeId = randomUUID();

    const startedAt = '2025-01-01T00:00:00.000Z';
    const effectiveAt = '2025-02-01T00:00:00.000Z';

    const [sub] = await db
      .insert(kilo_pass_subscriptions)
      .values({
        kilo_user_id: user.id,
        stripe_subscription_id: stripeSubId,
        tier: KiloPassTier.Tier19,
        cadence: KiloPassCadence.Yearly,
        status: 'active',
        cancel_at_period_end: false,
        started_at: startedAt,
        ended_at: null,
        current_streak_months: 0,
        next_yearly_issue_at: effectiveAt,
      })
      .returning({ id: kilo_pass_subscriptions.id });
    if (!sub) throw new Error('Failed to insert subscription');

    // 1 month of credits issued (Jan)
    await seedBaseIssuance({
      subscriptionId: sub.id,
      kiloUserId: user.id,
      issueMonth: '2025-01-01',
      amountUsd: 19,
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
      start_date_seconds: 1_735_689_600, // 2025-01-01
      metadata: meta,
    });

    const retrieve = jest.fn(async () => subscription);
    const release = jest.fn(async (_scheduleId: string) => ({}));
    const list = makeInvoicesListMock({
      yearlyPeriodStartSeconds: 1_735_689_600, // 2025-01-01
      yearlyPeriodEndSeconds: 1_767_225_600, // 2026-01-01
    });
    const stripe = {
      subscriptions: { retrieve },
      subscriptionSchedules: { release },
      invoices: { list },
    };

    const priceId = await getKiloPassPriceId({
      tier: KiloPassTier.Tier49,
      cadence: KiloPassCadence.Yearly,
    });

    const invoiceId = `inv_yearly_upgrade_month1_${Math.random()}`;
    const invoice = makeStripeInvoice({
      id: invoiceId,
      amount_paid_cents: 49_00 * 12,
      period_start_seconds: 1_738_368_000, // 2025-02-01
      created_seconds: 1_738_368_000,
      paid_seconds: 1_738_368_000,
      priceId,
      subscriptionIdOrExpanded: stripeSubId,
      metadata: meta,
    });

    await handleKiloPassInvoicePaid({
      eventId: 'evt_test_yearly_upgrade_month1',
      invoice,
      stripe: stripe as unknown as Stripe,
    });

    const syntheticInvoiceId = `kilo-pass-yearly-remaining:${scheduledChangeId}`;
    const remainingTx = await db.query.credit_transactions.findFirst({
      where: eq(credit_transactions.stripe_payment_id, syntheticInvoiceId),
    });
    expect(remainingTx).toBeTruthy();
    // 1 month used, 11 remaining × $19 = $209
    expect(remainingTx?.amount_microdollars).toBe(209_000_000);

    const remainingAuditLog = await db.query.kilo_pass_audit_log.findFirst({
      where: eq(kilo_pass_audit_log.stripe_invoice_id, syntheticInvoiceId),
    });
    expect(remainingAuditLog?.payload_json).toEqual(
      expect.objectContaining({ remainingMonths: 11 })
    );
  });

  test('yearly: falls back to effective_at - 12 months when no matching yearly Stripe invoice found', async () => {
    const { handleKiloPassInvoicePaid } =
      await import('@/lib/kilo-pass/stripe-handlers-invoice-paid');

    const user = await insertTestUser({ total_microdollars_acquired: 0, microdollars_used: 0 });

    const stripeSubId = `sub_${Math.random()}`;
    const stripeScheduleId = `sched_${Math.random()}`;
    const scheduledChangeId = randomUUID();

    const startedAt = '2025-01-01T00:00:00.000Z';
    const effectiveAt = '2025-04-01T00:00:00.000Z';

    const [sub] = await db
      .insert(kilo_pass_subscriptions)
      .values({
        kilo_user_id: user.id,
        stripe_subscription_id: stripeSubId,
        tier: KiloPassTier.Tier19,
        cadence: KiloPassCadence.Yearly,
        status: 'active',
        cancel_at_period_end: false,
        started_at: startedAt,
        ended_at: null,
        current_streak_months: 0,
        next_yearly_issue_at: effectiveAt,
      })
      .returning({ id: kilo_pass_subscriptions.id });
    if (!sub) throw new Error('Failed to insert subscription');

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
      start_date_seconds: 1_735_689_600, // 2025-01-01
      metadata: meta,
    });

    const retrieve = jest.fn(async () => subscription);
    const release = jest.fn(async (_scheduleId: string) => ({}));
    // Return empty invoice list — no matching yearly invoice
    const list = jest.fn(async () => ({ data: [] }));
    const stripe = {
      subscriptions: { retrieve },
      subscriptionSchedules: { release },
      invoices: { list },
    };

    const priceId = await getKiloPassPriceId({
      tier: KiloPassTier.Tier49,
      cadence: KiloPassCadence.Yearly,
    });

    const invoiceId = `inv_yearly_upgrade_no_invoice_${Math.random()}`;
    const invoice = makeStripeInvoice({
      id: invoiceId,
      amount_paid_cents: 49_00 * 12,
      period_start_seconds: 1_743_465_600, // 2025-04-01
      created_seconds: 1_743_465_600,
      paid_seconds: 1_743_465_600,
      priceId,
      subscriptionIdOrExpanded: stripeSubId,
      metadata: meta,
    });

    await handleKiloPassInvoicePaid({
      eventId: 'evt_test_yearly_upgrade_no_invoice',
      invoice,
      stripe: stripe as unknown as Stripe,
    });

    // Fallback: effective_at - 12 months = Apr 2024. diff(Apr 2025, Apr 2024) = 12.
    // remaining = 0, so no credits issued.
    // This is conservative — better to under-issue than over-issue in the fallback.
    const syntheticInvoiceId = `kilo-pass-yearly-remaining:${scheduledChangeId}`;
    const remainingTx = await db.query.credit_transactions.findFirst({
      where: eq(credit_transactions.stripe_payment_id, syntheticInvoiceId),
    });
    expect(remainingTx).toBeUndefined();
  });

  test('yearly: multiple upgrades in same year — second upgrade uses its own billing cycle', async () => {
    // Scenario: yearly tier_19 (started Jan 2025), uptier to tier_49 at Mar 2025
    // (billing_cycle_anchor resets, new cycle Mar 2025 → Mar 2026), then uptier
    // again to tier_199 at May 2025. The second upgrade should see 2 months used
    // in the tier_49 cycle (Mar, Apr), giving 10 remaining × $49.
    const { handleKiloPassInvoicePaid } =
      await import('@/lib/kilo-pass/stripe-handlers-invoice-paid');

    const user = await insertTestUser({ total_microdollars_acquired: 0, microdollars_used: 0 });

    const stripeSubId = `sub_${Math.random()}`;
    const stripeScheduleId = `sched_${Math.random()}`;
    const scheduledChangeId = randomUUID();

    const startedAt = '2025-01-01T00:00:00.000Z';
    const effectiveAt = '2025-05-01T00:00:00.000Z';

    const [sub] = await db
      .insert(kilo_pass_subscriptions)
      .values({
        kilo_user_id: user.id,
        stripe_subscription_id: stripeSubId,
        // Already upgraded to tier_49 (first upgrade happened earlier)
        tier: KiloPassTier.Tier49,
        cadence: KiloPassCadence.Yearly,
        status: 'active',
        cancel_at_period_end: false,
        started_at: startedAt,
        ended_at: null,
        current_streak_months: 0,
        next_yearly_issue_at: effectiveAt,
      })
      .returning({ id: kilo_pass_subscriptions.id });
    if (!sub) throw new Error('Failed to insert subscription');

    await db.insert(kilo_pass_scheduled_changes).values({
      id: scheduledChangeId,
      kilo_user_id: user.id,
      stripe_subscription_id: stripeSubId,
      from_tier: KiloPassTier.Tier49,
      from_cadence: KiloPassCadence.Yearly,
      to_tier: KiloPassTier.Tier199,
      to_cadence: KiloPassCadence.Yearly,
      stripe_schedule_id: stripeScheduleId,
      effective_at: effectiveAt,
      status: KiloPassScheduledChangeStatus.NotStarted,
    });

    const meta = kiloPassMetadata({
      kiloUserId: user.id,
      tier: KiloPassTier.Tier199,
      cadence: KiloPassCadence.Yearly,
      kiloPassScheduledChangeId: scheduledChangeId,
    });

    const subscription = makeStripeSubscription({
      id: stripeSubId,
      start_date_seconds: 1_735_689_600, // 2025-01-01
      metadata: meta,
    });

    const retrieve = jest.fn(async () => subscription);
    const release = jest.fn(async (_scheduleId: string) => ({}));
    // The tier_49 yearly cycle started Mar 2025 (after first uptier reset the anchor).
    const list = makeInvoicesListMock({
      yearlyPeriodStartSeconds: 1_740_787_200, // 2025-03-01
      yearlyPeriodEndSeconds: 1_772_323_200, // 2026-03-01
    });
    const stripe = {
      subscriptions: { retrieve },
      subscriptionSchedules: { release },
      invoices: { list },
    };

    const priceId = await getKiloPassPriceId({
      tier: KiloPassTier.Tier199,
      cadence: KiloPassCadence.Yearly,
    });

    const invoiceId = `inv_yearly_double_upgrade_${Math.random()}`;
    const invoice = makeStripeInvoice({
      id: invoiceId,
      amount_paid_cents: 199_00 * 12,
      period_start_seconds: 1_746_057_600, // 2025-05-01
      created_seconds: 1_746_057_600,
      paid_seconds: 1_746_057_600,
      priceId,
      subscriptionIdOrExpanded: stripeSubId,
      metadata: meta,
    });

    await handleKiloPassInvoicePaid({
      eventId: 'evt_test_yearly_double_upgrade',
      invoice,
      stripe: stripe as unknown as Stripe,
    });

    const syntheticInvoiceId = `kilo-pass-yearly-remaining:${scheduledChangeId}`;
    const remainingTx = await db.query.credit_transactions.findFirst({
      where: eq(credit_transactions.stripe_payment_id, syntheticInvoiceId),
    });
    expect(remainingTx).toBeTruthy();
    // 2 months used (Mar, Apr) in the tier_49 cycle. 10 remaining × $49 = $490.
    expect(remainingTx?.amount_microdollars).toBe(490_000_000);

    const remainingAuditLog = await db.query.kilo_pass_audit_log.findFirst({
      where: eq(kilo_pass_audit_log.stripe_invoice_id, syntheticInvoiceId),
    });
    expect(remainingAuditLog?.payload_json).toEqual(
      expect.objectContaining({ remainingMonths: 10 })
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
