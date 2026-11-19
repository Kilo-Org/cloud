import { beforeEach, describe, expect, jest, test } from '@jest/globals';

import { cleanupDbForTest, db } from '@kilocode/web-shared/lib/drizzle';
import {
  credit_transactions,
  kilo_pass_audit_log,
  kilo_pass_issuance_items,
  kilo_pass_issuances,
  kilo_pass_scheduled_changes,
  kilo_pass_subscriptions,
  kilocode_users,
} from '@kilocode/db/schema';
import {
  KiloPassAuditLogAction,
  KiloPassAuditLogResult,
  KiloPassCadence,
  KiloPassIssuanceItemKind,
  KiloPassIssuanceSource,
  KiloPassScheduledChangeStatus,
  KiloPassTier,
} from '@kilocode/web-shared/lib/kilo-pass/enums';
import {
  createOrGetIssuanceHeader,
  issueBaseCreditsForIssuance,
} from '@kilocode/web-shared/lib/kilo-pass/issuance';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { and, asc, eq, sql } from 'drizzle-orm';
import type Stripe from 'stripe';

import { runKiloPassYearlyMonthlyBaseCron } from '@/lib/kilo-pass/yearly-monthly-base-cron';

const mockStripeSubscriptionsRetrieve = jest.fn<(id: string) => Promise<Stripe.Subscription>>();
jest.mock('@kilocode/web-shared/lib/stripe-client', () => ({
  client: {
    subscriptions: {
      retrieve: (id: string) => mockStripeSubscriptionsRetrieve(id),
    },
  },
}));

jest.mock('@/lib/kilo-pass/posthog-tracking', () => ({
  runAfterResponse: async (work: () => Promise<void>) => {
    await work();
  },
  trackKiloPassPurchaseCompleted: jest.fn(),
}));

const env = process.env;
env.STRIPE_KILO_PASS_TIER_19_MONTHLY_PRICE_ID ||= 'price_test_kilo_pass_tier_19_monthly';
env.STRIPE_KILO_PASS_TIER_19_YEARLY_PRICE_ID ||= 'price_test_kilo_pass_tier_19_yearly';
env.STRIPE_KILO_PASS_TIER_49_MONTHLY_PRICE_ID ||= 'price_test_kilo_pass_tier_49_monthly';
env.STRIPE_KILO_PASS_TIER_49_YEARLY_PRICE_ID ||= 'price_test_kilo_pass_tier_49_yearly';
env.STRIPE_KILO_PASS_TIER_199_MONTHLY_PRICE_ID ||= 'price_test_kilo_pass_tier_199_monthly';
env.STRIPE_KILO_PASS_TIER_199_YEARLY_PRICE_ID ||= 'price_test_kilo_pass_tier_199_yearly';

const STARTER_PAID_AT = '2026-10-09T19:44:45.000Z';
const UPGRADE_AT = '2026-11-09T19:44:45.000Z';
const CRON_AFTER_UPGRADE = new Date('2026-11-09T20:00:00.000Z');
const PRO_PAID_AT = '2026-11-09T20:45:10.000Z';

function unix(iso: string): number {
  return Math.floor(new Date(iso).getTime() / 1000);
}

function iso(value: string | null | undefined): string | null {
  return value ? new Date(value).toISOString() : null;
}

type Incident = {
  kiloUserId: string;
  subscriptionId: string;
  stripeSubscriptionId: string;
  starterInvoiceId: string;
  scheduledChangeId: string;
};

async function seedPaidStarterYearlyWithScheduledUpgrade(params?: {
  status?: 'active' | 'paused';
}): Promise<Incident> {
  const user = await insertTestUser({ total_microdollars_acquired: 0, microdollars_used: 0 });
  const stripeSubscriptionId = `sub_incident_${crypto.randomUUID()}`;
  const starterInvoiceId = `in_starter_${crypto.randomUUID()}`;

  const [row] = await db
    .insert(kilo_pass_subscriptions)
    .values({
      kilo_user_id: user.id,
      provider_subscription_id: stripeSubscriptionId,
      stripe_subscription_id: stripeSubscriptionId,
      tier: KiloPassTier.Tier19,
      cadence: KiloPassCadence.Yearly,
      status: params?.status ?? 'active',
      started_at: STARTER_PAID_AT,
      ended_at: null,
      current_streak_months: 0,
      next_yearly_issue_at: UPGRADE_AT,
    })
    .returning({ id: kilo_pass_subscriptions.id });
  if (!row) throw new Error('Failed to insert subscription');

  await db.transaction(async tx => {
    const header = await createOrGetIssuanceHeader(tx, {
      subscriptionId: row.id,
      issueMonth: '2026-10-01',
      source: KiloPassIssuanceSource.StripeInvoice,
      stripeInvoiceId: starterInvoiceId,
    });
    await issueBaseCreditsForIssuance(tx, {
      issuanceId: header.issuanceId,
      subscriptionId: row.id,
      kiloUserId: user.id,
      amountUsd: 19,
      stripeInvoiceId: starterInvoiceId,
      description: 'Kilo Pass base credits (tier_19, yearly)',
      issuedAt: STARTER_PAID_AT,
    });
  });

  const scheduledChangeId = crypto.randomUUID();
  await db.insert(kilo_pass_scheduled_changes).values({
    id: scheduledChangeId,
    kilo_user_id: user.id,
    stripe_subscription_id: stripeSubscriptionId,
    from_tier: KiloPassTier.Tier19,
    from_cadence: KiloPassCadence.Yearly,
    to_tier: KiloPassTier.Tier49,
    to_cadence: KiloPassCadence.Yearly,
    stripe_schedule_id: `sched_${crypto.randomUUID()}`,
    effective_at: UPGRADE_AT,
    status: KiloPassScheduledChangeStatus.Active,
  });

  return {
    kiloUserId: user.id,
    subscriptionId: row.id,
    stripeSubscriptionId,
    starterInvoiceId,
    scheduledChangeId,
  };
}

function proStripeSubscription(
  incident: Incident,
  status: Stripe.Subscription.Status
): Stripe.Subscription {
  return {
    id: incident.stripeSubscriptionId,
    object: 'subscription',
    start_date: unix(STARTER_PAID_AT),
    status,
    cancel_at_period_end: false,
    ended_at: null,
    canceled_at: null,
    pause_collection: null,
    metadata: {
      type: 'kilo-pass',
      kiloUserId: incident.kiloUserId,
      tier: KiloPassTier.Tier49,
      cadence: KiloPassCadence.Yearly,
      kiloPassScheduledChangeId: incident.scheduledChangeId,
    },
    items: { object: 'list', data: [], has_more: false, url: '/v1/subscription_items' },
  } as unknown as Stripe.Subscription;
}

async function applyUpgradePhase(
  incident: Incident,
  status: Stripe.Subscription.Status = 'active'
): Promise<void> {
  const { handleKiloPassSubscriptionEvent } =
    await import('@/lib/kilo-pass/stripe-handlers-subscription-events');
  const subscription = proStripeSubscription(incident, status);
  mockStripeSubscriptionsRetrieve.mockResolvedValue(subscription);
  await handleKiloPassSubscriptionEvent({
    eventId: `evt_phase_${crypto.randomUUID()}`,
    eventType: 'customer.subscription.updated',
    subscription,
  });
}

function yearlyLine(params: { priceId: string; periodStartIso: string }): Stripe.InvoiceLineItem {
  const start = unix(params.periodStartIso);
  return {
    id: `il_${crypto.randomUUID()}`,
    object: 'line_item',
    metadata: {},
    pricing: { price_details: { price: params.priceId } },
    parent: {
      type: 'subscription_item_details',
      subscription_item_details: { proration: false },
    },
    period: { start, end: start + 365 * 86_400 },
  } as unknown as Stripe.InvoiceLineItem;
}

async function payUpgradeInvoice(
  incident: Incident,
  params: { paidAtIso: string; invoiceId: string; eventId: string }
): Promise<void> {
  const { handleKiloPassInvoicePaid } =
    await import('@/lib/kilo-pass/stripe-handlers-invoice-paid');
  const { getStripePriceIdForKiloPass } =
    await import('@kilocode/web-shared/lib/kilo-pass/stripe-price-ids.server');
  const proPriceId = getStripePriceIdForKiloPass({
    tier: KiloPassTier.Tier49,
    cadence: KiloPassCadence.Yearly,
  });
  const starterPriceId = getStripePriceIdForKiloPass({
    tier: KiloPassTier.Tier19,
    cadence: KiloPassCadence.Yearly,
  });
  const subscription = proStripeSubscription(incident, 'active');

  const stripe = {
    subscriptions: { retrieve: jest.fn(async () => subscription) },
    subscriptionSchedules: { release: jest.fn(async () => ({})) },
    invoices: {
      list: jest.fn(async () => ({
        data: [
          {
            id: incident.starterInvoiceId,
            lines: {
              has_more: false,
              data: [yearlyLine({ priceId: starterPriceId, periodStartIso: STARTER_PAID_AT })],
            },
          },
        ],
      })),
    },
  };

  const invoice = {
    id: params.invoiceId,
    object: 'invoice',
    amount_paid: 58_800,
    billing_reason: 'subscription_update',
    currency: 'usd',
    livemode: false,
    created: unix(UPGRADE_AT),
    period_start: unix(UPGRADE_AT),
    status: 'paid',
    status_transitions: { paid_at: unix(params.paidAtIso) },
    discounts: [],
    parent: {
      subscription_details: {
        subscription: incident.stripeSubscriptionId,
        metadata: subscription.metadata,
      },
    },
    lines: {
      object: 'list',
      has_more: false,
      url: `/v1/invoices/${params.invoiceId}/lines`,
      data: [yearlyLine({ priceId: proPriceId, periodStartIso: UPGRADE_AT })],
    },
  } as unknown as Stripe.Invoice;

  await handleKiloPassInvoicePaid({
    eventId: params.eventId,
    invoice,
    stripe: stripe as unknown as Stripe,
  });
}

async function getBaseIssuances(subscriptionId: string) {
  return await db
    .select({
      issueMonth: kilo_pass_issuances.issue_month,
      source: kilo_pass_issuances.source,
      baseAmountUsd: kilo_pass_issuance_items.amount_usd,
    })
    .from(kilo_pass_issuances)
    .leftJoin(
      kilo_pass_issuance_items,
      and(
        eq(kilo_pass_issuance_items.kilo_pass_issuance_id, kilo_pass_issuances.id),
        eq(kilo_pass_issuance_items.kind, KiloPassIssuanceItemKind.Base)
      )
    )
    .where(eq(kilo_pass_issuances.kilo_pass_subscription_id, subscriptionId))
    .orderBy(asc(kilo_pass_issuances.issue_month));
}

async function getCreditTotalUsd(kiloUserId: string): Promise<number> {
  const [row] = await db
    .select({
      total: sql<number>`coalesce(sum(${credit_transactions.amount_microdollars}), 0)::bigint`,
    })
    .from(credit_transactions)
    .where(eq(credit_transactions.kilo_user_id, kiloUserId));
  return Number(row?.total ?? 0) / 1_000_000;
}

async function getCursor(subscriptionId: string): Promise<string | null> {
  const row = await db.query.kilo_pass_subscriptions.findFirst({
    columns: { next_yearly_issue_at: true },
    where: eq(kilo_pass_subscriptions.id, subscriptionId),
  });
  return iso(row?.next_yearly_issue_at);
}

async function getHoldAudits(subscriptionId: string) {
  return await db
    .select({ result: kilo_pass_audit_log.result, payload: kilo_pass_audit_log.payload_json })
    .from(kilo_pass_audit_log)
    .where(
      and(
        eq(kilo_pass_audit_log.kilo_pass_subscription_id, subscriptionId),
        eq(kilo_pass_audit_log.action, KiloPassAuditLogAction.BaseCreditsIssued),
        sql`${kilo_pass_audit_log.payload_json}->>'kind' = 'yearly_monthly_base'`,
        sql`${kilo_pass_audit_log.payload_json}->>'reason' is not null`
      )
    );
}

function monthlyIssuancesThrough(lastMonth: string, amountUsd: number, firstMonth: string) {
  const months: { issueMonth: string; source: string; baseAmountUsd: number }[] = [];
  let cursor = new Date(`${firstMonth}T00:00:00.000Z`);
  const end = new Date(`${lastMonth}T00:00:00.000Z`);
  while (cursor <= end) {
    months.push({
      issueMonth: cursor.toISOString().slice(0, 10),
      source: KiloPassIssuanceSource.Cron,
      baseAmountUsd: amountUsd,
    });
    cursor = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 1));
  }
  return months;
}

beforeEach(async () => {
  await cleanupDbForTest();
  mockStripeSubscriptionsRetrieve.mockReset();
});

describe('yearly tier upgrade whose annual invoice is not paid', () => {
  test('cron issues nothing at the unpaid tier and holds the cursor (incident)', async () => {
    const incident = await seedPaidStarterYearlyWithScheduledUpgrade();
    await applyUpgradePhase(incident);

    const row = await db.query.kilo_pass_subscriptions.findFirst({
      where: eq(kilo_pass_subscriptions.id, incident.subscriptionId),
    });
    expect(row?.tier).toBe(KiloPassTier.Tier49);
    expect(row?.status).toBe('active');

    const summary = await runKiloPassYearlyMonthlyBaseCron(db, { now: CRON_AFTER_UPGRADE });

    expect(await getBaseIssuances(incident.subscriptionId)).toEqual([
      { issueMonth: '2026-10-01', source: KiloPassIssuanceSource.StripeInvoice, baseAmountUsd: 19 },
    ]);
    expect(await getCreditTotalUsd(incident.kiloUserId)).toBe(19);
    expect(await getCursor(incident.subscriptionId)).toBe(UPGRADE_AT);
    expect(summary).toMatchObject({
      dueSubscriptionCount: 1,
      baseIssuedCount: 0,
      baseHeldForUnpaidTierChangeCount: 1,
      nextYearlyIssueAtAdvancedCount: 0,
    });
    expect(await getHoldAudits(incident.subscriptionId)).toEqual([
      {
        result: KiloPassAuditLogResult.SkippedIdempotent,
        payload: expect.objectContaining({
          reason: 'row_tier_not_paid',
          issueMonth: '2026-11-01',
          nextYearlyIssueAt: UPGRADE_AT,
          rowTier: KiloPassTier.Tier49,
          rowTierBaseAmountUsd: 49,
          paidBaseAmountUsd: 19,
          pendingScheduledChangeId: incident.scheduledChangeId,
        }),
      },
    ]);

    await db
      .update(kilo_pass_scheduled_changes)
      .set({ deleted_at: '2026-11-12T10:00:00.000Z' })
      .where(eq(kilo_pass_scheduled_changes.id, incident.scheduledChangeId));
    await runKiloPassYearlyMonthlyBaseCron(db, { now: new Date('2026-11-12T11:00:00.000Z') });

    expect(await getBaseIssuances(incident.subscriptionId)).toHaveLength(1);
    expect(await getCreditTotalUsd(incident.kiloUserId)).toBe(19);
    expect(await getCursor(incident.subscriptionId)).toBe(UPGRADE_AT);
    const holds = await getHoldAudits(incident.subscriptionId);
    expect(holds).toHaveLength(2);
    expect(holds[1]?.payload).toMatchObject({
      reason: 'row_tier_not_paid',
      pendingScheduledChangeId: null,
    });
  });

  test('cron run before the phase applies holds on the scheduled change', async () => {
    const incident = await seedPaidStarterYearlyWithScheduledUpgrade();

    await runKiloPassYearlyMonthlyBaseCron(db, { now: CRON_AFTER_UPGRADE });

    expect(await getBaseIssuances(incident.subscriptionId)).toHaveLength(1);
    expect(await getCursor(incident.subscriptionId)).toBe(UPGRADE_AT);
    expect(await getHoldAudits(incident.subscriptionId)).toEqual([
      {
        result: KiloPassAuditLogResult.SkippedIdempotent,
        payload: expect.objectContaining({
          reason: 'scheduled_change_not_paid',
          rowTier: KiloPassTier.Tier19,
          paidBaseAmountUsd: 19,
          pendingScheduledChangeId: incident.scheduledChangeId,
          pendingScheduledChangeToTier: KiloPassTier.Tier49,
        }),
      },
    ]);

    await applyUpgradePhase(incident);
    await payUpgradeInvoice(incident, {
      paidAtIso: PRO_PAID_AT,
      invoiceId: `in_pro_${crypto.randomUUID()}`,
      eventId: `evt_pro_paid_${crypto.randomUUID()}`,
    });
    await runKiloPassYearlyMonthlyBaseCron(db, { now: new Date('2026-12-09T21:00:00.000Z') });

    expect(await getBaseIssuances(incident.subscriptionId)).toEqual([
      { issueMonth: '2026-10-01', source: KiloPassIssuanceSource.StripeInvoice, baseAmountUsd: 19 },
      { issueMonth: '2026-11-01', source: KiloPassIssuanceSource.StripeInvoice, baseAmountUsd: 49 },
      { issueMonth: '2026-12-01', source: KiloPassIssuanceSource.Cron, baseAmountUsd: 49 },
    ]);
  });

  test('upgrade paid after the cron held: invoice owns the month and the new tier runs through year end', async () => {
    const incident = await seedPaidStarterYearlyWithScheduledUpgrade();
    await applyUpgradePhase(incident);
    await runKiloPassYearlyMonthlyBaseCron(db, { now: CRON_AFTER_UPGRADE });

    const proInvoiceId = `in_pro_${crypto.randomUUID()}`;
    const proPaidEventId = `evt_pro_paid_${crypto.randomUUID()}`;
    await payUpgradeInvoice(incident, {
      paidAtIso: PRO_PAID_AT,
      invoiceId: proInvoiceId,
      eventId: proPaidEventId,
    });
    await payUpgradeInvoice(incident, {
      paidAtIso: PRO_PAID_AT,
      invoiceId: proInvoiceId,
      eventId: proPaidEventId,
    });

    const row = await db.query.kilo_pass_subscriptions.findFirst({
      where: eq(kilo_pass_subscriptions.id, incident.subscriptionId),
    });
    expect(row?.tier).toBe(KiloPassTier.Tier49);
    expect(await getCursor(incident.subscriptionId)).toBe('2026-12-09T20:45:10.000Z');
    expect(await getBaseIssuances(incident.subscriptionId)).toEqual([
      { issueMonth: '2026-10-01', source: KiloPassIssuanceSource.StripeInvoice, baseAmountUsd: 19 },
      { issueMonth: '2026-11-01', source: KiloPassIssuanceSource.StripeInvoice, baseAmountUsd: 49 },
    ]);
    const remaining = await db.query.credit_transactions.findFirst({
      where: eq(
        credit_transactions.stripe_payment_id,
        `kilo-pass-yearly-remaining:${incident.scheduledChangeId}`
      ),
    });
    expect(remaining?.amount_microdollars).toBe(11 * 19 * 1_000_000);
    expect(await getCreditTotalUsd(incident.kiloUserId)).toBe(19 + 49 + 11 * 19);

    await runKiloPassYearlyMonthlyBaseCron(db, { now: new Date('2026-11-09T21:00:00.000Z') });
    expect(await getBaseIssuances(incident.subscriptionId)).toHaveLength(2);

    const yearEnd = new Date('2027-11-10T00:00:00.000Z');
    await runKiloPassYearlyMonthlyBaseCron(db, { now: yearEnd });
    await runKiloPassYearlyMonthlyBaseCron(db, { now: yearEnd });

    expect(await getBaseIssuances(incident.subscriptionId)).toEqual([
      { issueMonth: '2026-10-01', source: KiloPassIssuanceSource.StripeInvoice, baseAmountUsd: 19 },
      { issueMonth: '2026-11-01', source: KiloPassIssuanceSource.StripeInvoice, baseAmountUsd: 49 },
      ...monthlyIssuancesThrough('2027-10-01', 49, '2026-12-01'),
    ]);
    expect(await getCursor(incident.subscriptionId)).toBe('2027-12-09T20:45:10.000Z');
    expect(await getCreditTotalUsd(incident.kiloUserId)).toBe(19 + 12 * 49 + 11 * 19);
  });

  test('upgrade paid before the cron runs is unchanged', async () => {
    const incident = await seedPaidStarterYearlyWithScheduledUpgrade();
    await applyUpgradePhase(incident);
    await payUpgradeInvoice(incident, {
      paidAtIso: '2026-11-09T19:45:30.000Z',
      invoiceId: `in_pro_${crypto.randomUUID()}`,
      eventId: `evt_pro_paid_${crypto.randomUUID()}`,
    });

    const firstRun = await runKiloPassYearlyMonthlyBaseCron(db, { now: CRON_AFTER_UPGRADE });
    expect(firstRun.dueSubscriptionCount).toBe(0);

    await runKiloPassYearlyMonthlyBaseCron(db, { now: new Date('2026-12-09T20:00:00.000Z') });

    expect(await getBaseIssuances(incident.subscriptionId)).toEqual([
      { issueMonth: '2026-10-01', source: KiloPassIssuanceSource.StripeInvoice, baseAmountUsd: 19 },
      { issueMonth: '2026-11-01', source: KiloPassIssuanceSource.StripeInvoice, baseAmountUsd: 49 },
      { issueMonth: '2026-12-01', source: KiloPassIssuanceSource.Cron, baseAmountUsd: 49 },
    ]);
    expect(await getHoldAudits(incident.subscriptionId)).toEqual([]);
  });

  test('past_due upgrade is skipped until paid, then the cron resumes from the new cursor', async () => {
    const incident = await seedPaidStarterYearlyWithScheduledUpgrade();
    await applyUpgradePhase(incident, 'past_due');

    const pastDueRun = await runKiloPassYearlyMonthlyBaseCron(db, {
      now: new Date('2026-11-09T21:00:00.000Z'),
    });
    expect(pastDueRun.dueSubscriptionCount).toBe(0);
    expect(await getBaseIssuances(incident.subscriptionId)).toHaveLength(1);

    await payUpgradeInvoice(incident, {
      paidAtIso: '2026-11-12T10:00:00.000Z',
      invoiceId: `in_pro_${crypto.randomUUID()}`,
      eventId: `evt_pro_paid_${crypto.randomUUID()}`,
    });
    const row = await db.query.kilo_pass_subscriptions.findFirst({
      where: eq(kilo_pass_subscriptions.id, incident.subscriptionId),
    });
    expect(row?.status).toBe('active');
    expect(await getCursor(incident.subscriptionId)).toBe('2026-12-12T10:00:00.000Z');

    await runKiloPassYearlyMonthlyBaseCron(db, { now: new Date('2026-12-12T11:00:00.000Z') });

    expect(await getBaseIssuances(incident.subscriptionId)).toEqual([
      { issueMonth: '2026-10-01', source: KiloPassIssuanceSource.StripeInvoice, baseAmountUsd: 19 },
      { issueMonth: '2026-11-01', source: KiloPassIssuanceSource.StripeInvoice, baseAmountUsd: 49 },
      { issueMonth: '2026-12-01', source: KiloPassIssuanceSource.Cron, baseAmountUsd: 49 },
    ]);
  });

  test('usage bonus during the hold creates no future-month issuance', async () => {
    const { maybeIssueKiloPassBonusFromUsageThreshold } =
      await import('@kilocode/web-shared/lib/kilo-pass/usage-triggered-bonus');
    const incident = await seedPaidStarterYearlyWithScheduledUpgrade();
    await applyUpgradePhase(incident);
    await runKiloPassYearlyMonthlyBaseCron(db, { now: CRON_AFTER_UPGRADE });

    await db
      .update(kilocode_users)
      .set({ microdollars_used: 19_000_000, kilo_pass_threshold: 19_000_000 })
      .where(eq(kilocode_users.id, incident.kiloUserId));
    await maybeIssueKiloPassBonusFromUsageThreshold({
      kiloUserId: incident.kiloUserId,
      nowIso: '2026-11-09T20:30:00.000Z',
    });

    expect(await getBaseIssuances(incident.subscriptionId)).toEqual([
      { issueMonth: '2026-10-01', source: KiloPassIssuanceSource.StripeInvoice, baseAmountUsd: 19 },
    ]);
    expect(await getCursor(incident.subscriptionId)).toBe(UPGRADE_AT);
  });
});

describe('yearly subscription at its paid tier', () => {
  test('paused row issues the paid tier as before', async () => {
    const incident = await seedPaidStarterYearlyWithScheduledUpgrade({ status: 'paused' });
    await db
      .delete(kilo_pass_scheduled_changes)
      .where(eq(kilo_pass_scheduled_changes.id, incident.scheduledChangeId));

    const summary = await runKiloPassYearlyMonthlyBaseCron(db, { now: CRON_AFTER_UPGRADE });

    expect(summary).toMatchObject({ baseIssuedCount: 1, baseHeldForUnpaidTierChangeCount: 0 });
    expect(await getBaseIssuances(incident.subscriptionId)).toEqual([
      { issueMonth: '2026-10-01', source: KiloPassIssuanceSource.StripeInvoice, baseAmountUsd: 19 },
      { issueMonth: '2026-11-01', source: KiloPassIssuanceSource.Cron, baseAmountUsd: 19 },
    ]);
    expect(await getCursor(incident.subscriptionId)).toBe('2026-12-09T19:44:45.000Z');
  });
});
