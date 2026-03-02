import { beforeEach, describe, expect, test } from '@jest/globals';

import {
  credit_transactions,
  kilo_pass_audit_log,
  kilo_pass_issuance_items,
  kilo_pass_issuances,
  kilo_pass_subscriptions,
  kilocode_users,
} from '@kilocode/db/schema';
import { db, cleanupDbForTest } from '@/lib/drizzle';
import { insertTestUser } from '@/tests/helpers/user.helper';
import {
  KiloPassAuditLogAction,
  KiloPassCadence,
  KiloPassIssuanceItemKind,
  KiloPassIssuanceSource,
  KiloPassTier,
} from '@/lib/kilo-pass/enums';
import { computeMonthlyCadenceBonusPercent, getMonthlyPriceUsd } from '@/lib/kilo-pass/bonus';
import { KILO_PASS_MONTHLY_FIRST_2_MONTHS_PROMO_CUTOFF } from '@/lib/kilo-pass/constants';
import { maybeIssueKiloPassBonusFromUsageThreshold } from '@/lib/kilo-pass/usage-triggered-bonus';
import { and, eq } from 'drizzle-orm';

beforeEach(async () => {
  await cleanupDbForTest();
});

async function seedBaseIssuance(params: {
  kiloUserId: string;
  cadence: KiloPassCadence;
  tier: KiloPassTier;
  issueMonth: string;
  stripeInvoiceId: string | null;
  currentStreakMonths: number;
  nextYearlyIssueAt: string | null;
  startedAtIso?: string | null;
}) {
  const {
    kiloUserId,
    cadence,
    tier,
    issueMonth,
    stripeInvoiceId,
    currentStreakMonths,
    nextYearlyIssueAt,
    startedAtIso,
  } = params;

  const subscriptionRow = await db
    .insert(kilo_pass_subscriptions)
    .values({
      kilo_user_id: kiloUserId,
      stripe_subscription_id: `sub_${Math.random()}`,
      tier,
      cadence,
      status: 'active',
      cancel_at_period_end: false,
      started_at: startedAtIso ?? new Date('2026-01-01T00:00:00.000Z').toISOString(),
      ended_at: null,
      current_streak_months: currentStreakMonths,
      next_yearly_issue_at: nextYearlyIssueAt,
    })
    .returning({ id: kilo_pass_subscriptions.id });

  const subscriptionId = subscriptionRow[0]?.id;
  if (!subscriptionId) throw new Error('Failed to insert subscription');

  const issuanceRow = await db
    .insert(kilo_pass_issuances)
    .values({
      kilo_pass_subscription_id: subscriptionId,
      issue_month: issueMonth,
      source: KiloPassIssuanceSource.StripeInvoice,
      stripe_invoice_id: stripeInvoiceId,
    })
    .returning({ id: kilo_pass_issuances.id });

  const issuanceId = issuanceRow[0]?.id;
  if (!issuanceId) throw new Error('Failed to insert issuance');

  const baseCreditTxId = crypto.randomUUID();
  await db.insert(credit_transactions).values({
    id: baseCreditTxId,
    kilo_user_id: kiloUserId,
    is_free: false,
    amount_microdollars: 1_000_000,
    description: 'seed base credits',
    original_baseline_microdollars_used: 0,
    stripe_payment_id: stripeInvoiceId ?? null,
  });

  await db.insert(kilo_pass_issuance_items).values({
    kilo_pass_issuance_id: issuanceId,
    kind: KiloPassIssuanceItemKind.Base,
    credit_transaction_id: baseCreditTxId,
    amount_usd: 1,
    bonus_percent_applied: null,
  });

  return { subscriptionId, issuanceId };
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

describe('maybeIssueKiloPassBonusFromUsageThreshold', () => {
  test('monthly: issues regular bonus once and clears kilo_pass_threshold', async () => {
    const user = await insertTestUser({
      microdollars_used: 20_000_000,
      kilo_pass_threshold: 19_000_000,
    });

    const { issuanceId } = await seedBaseIssuance({
      kiloUserId: user.id,
      cadence: KiloPassCadence.Monthly,
      tier: KiloPassTier.Tier19,
      issueMonth: '2026-01-01',
      stripeInvoiceId: 'inv_test_monthly',
      currentStreakMonths: 2,
      nextYearlyIssueAt: null,
      // Ensure this test remains a "regular ramp" case, not eligible for the month-2 grandfathered promo.
      startedAtIso: new Date(
        KILO_PASS_MONTHLY_FIRST_2_MONTHS_PROMO_CUTOFF.valueOf() + 1
      ).toISOString(),
    });

    await maybeIssueKiloPassBonusFromUsageThreshold({
      kiloUserId: user.id,
      nowIso: new Date('2026-01-15T00:00:00.000Z').toISOString(),
      db,
    });

    const bonusItem = await db.query.kilo_pass_issuance_items.findFirst({
      where: and(
        eq(kilo_pass_issuance_items.kilo_pass_issuance_id, issuanceId),
        eq(kilo_pass_issuance_items.kind, KiloPassIssuanceItemKind.Bonus)
      ),
    });
    expect(bonusItem).toBeTruthy();

    const bonusTx = await db.query.credit_transactions.findFirst({
      where: eq(credit_transactions.id, bonusItem?.credit_transaction_id ?? ''),
    });
    expect(bonusTx?.is_free).toBe(true);
    // tier_19 at streak=2 => base 5% + step 5% * 1 = 10% of $19.00 = $1.90.
    expect(bonusTx?.amount_microdollars).toBe(1_900_000);

    const userRow = await db.query.kilocode_users.findFirst({
      where: eq(kilocode_users.id, user.id),
    });
    expect(userRow?.kilo_pass_threshold).toBeNull();
  });

  test('monthly: first-2-months promo eligible => 50% bonus (tier_49, streak=2)', async () => {
    const user = await insertTestUser({
      microdollars_used: 55_000_000,
      kilo_pass_threshold: 49_000_000,
    });

    const { issuanceId } = await seedBaseIssuance({
      kiloUserId: user.id,
      cadence: KiloPassCadence.Monthly,
      tier: KiloPassTier.Tier49,
      issueMonth: '2026-02-01',
      stripeInvoiceId: 'inv_test_monthly_month2_grandfathered_eligible',
      currentStreakMonths: 2,
      nextYearlyIssueAt: null,
      startedAtIso: '2026-01-26T23:59:59.000Z',
    });

    await maybeIssueKiloPassBonusFromUsageThreshold({
      kiloUserId: user.id,
      nowIso: new Date('2026-02-15T00:00:00.000Z').toISOString(),
      db,
    });

    const bonusItem = await db.query.kilo_pass_issuance_items.findFirst({
      where: and(
        eq(kilo_pass_issuance_items.kilo_pass_issuance_id, issuanceId),
        eq(kilo_pass_issuance_items.kind, KiloPassIssuanceItemKind.Bonus)
      ),
    });
    expect(bonusItem).toBeTruthy();

    const bonusTx = await db.query.credit_transactions.findFirst({
      where: eq(credit_transactions.id, bonusItem?.credit_transaction_id ?? ''),
    });
    // tier_49 monthly price is $49, 50% => $24.50.
    expect(bonusTx?.amount_microdollars).toBe(24_500_000);

    const auditRows = await db
      .select({ payload: kilo_pass_audit_log.payload_json })
      .from(kilo_pass_audit_log)
      .where(
        and(
          eq(kilo_pass_audit_log.action, KiloPassAuditLogAction.BonusCreditsIssued),
          eq(kilo_pass_audit_log.related_monthly_issuance_id, issuanceId)
        )
      );

    const payload = auditRows[0]?.payload ?? null;
    expect(isRecord(payload)).toBe(true);
    if (!isRecord(payload))
      throw new Error('Expected bonus issuance audit payload to be an object');

    const decision = payload.monthlyBonusDecision;
    expect(isRecord(decision)).toBe(true);
    if (!isRecord(decision)) {
      throw new Error('Expected audit payload to include monthlyBonusDecision object');
    }

    expect(decision.streakMonths).toBe(2);
    expect(decision.issueMonth).toBe('2026-02-01');
  });

  test('monthly: first-2-months promo ineligible at cutoff => ramp applies (not 50%)', async () => {
    const user = await insertTestUser({
      microdollars_used: 55_000_000,
      kilo_pass_threshold: 49_000_000,
    });

    const { issuanceId } = await seedBaseIssuance({
      kiloUserId: user.id,
      cadence: KiloPassCadence.Monthly,
      tier: KiloPassTier.Tier49,
      issueMonth: '2026-02-01',
      stripeInvoiceId: 'inv_test_monthly_month2_grandfathered_ineligible_cutoff',
      currentStreakMonths: 2,
      nextYearlyIssueAt: null,
      startedAtIso: KILO_PASS_MONTHLY_FIRST_2_MONTHS_PROMO_CUTOFF.toISOString(),
    });

    await maybeIssueKiloPassBonusFromUsageThreshold({
      kiloUserId: user.id,
      nowIso: new Date('2026-02-15T00:00:00.000Z').toISOString(),
      db,
    });

    const bonusItem = await db.query.kilo_pass_issuance_items.findFirst({
      where: and(
        eq(kilo_pass_issuance_items.kilo_pass_issuance_id, issuanceId),
        eq(kilo_pass_issuance_items.kind, KiloPassIssuanceItemKind.Bonus)
      ),
    });
    expect(bonusItem).toBeTruthy();

    const bonusTx = await db.query.credit_transactions.findFirst({
      where: eq(credit_transactions.id, bonusItem?.credit_transaction_id ?? ''),
    });
    // tier_49 at streak=2 => base 5% + step 5% * 1 = 10% of $49.00 = $4.90.
    expect(bonusTx?.amount_microdollars).toBe(4_900_000);
  });

  test('monthly: first-2-months promo started AFTER cutoff => ramp applies (not 50%)', async () => {
    const user = await insertTestUser({
      microdollars_used: 55_000_000,
      kilo_pass_threshold: 49_000_000,
    });

    const tier = KiloPassTier.Tier49;
    const streakMonths = 2;
    const startedAtIso = new Date(
      KILO_PASS_MONTHLY_FIRST_2_MONTHS_PROMO_CUTOFF.valueOf() + 1
    ).toISOString();

    const { issuanceId } = await seedBaseIssuance({
      kiloUserId: user.id,
      cadence: KiloPassCadence.Monthly,
      tier,
      issueMonth: '2026-02-01',
      stripeInvoiceId: 'inv_test_monthly_month2_grandfathered_ineligible_after_cutoff',
      currentStreakMonths: streakMonths,
      nextYearlyIssueAt: null,
      startedAtIso,
    });

    await maybeIssueKiloPassBonusFromUsageThreshold({
      kiloUserId: user.id,
      nowIso: new Date('2026-02-15T00:00:00.000Z').toISOString(),
      db,
    });

    const bonusItem = await db.query.kilo_pass_issuance_items.findFirst({
      where: and(
        eq(kilo_pass_issuance_items.kilo_pass_issuance_id, issuanceId),
        eq(kilo_pass_issuance_items.kind, KiloPassIssuanceItemKind.Bonus)
      ),
    });
    expect(bonusItem).toBeTruthy();

    const bonusTx = await db.query.credit_transactions.findFirst({
      where: eq(credit_transactions.id, bonusItem?.credit_transaction_id ?? ''),
    });

    const expectedBonusPercent = computeMonthlyCadenceBonusPercent({
      tier,
      streakMonths,
      isFirstTimeSubscriberEver: true,
    });
    const expectedMonthlyPriceUsd = getMonthlyPriceUsd(tier);
    const expectedBonusMicrodollars = Math.round(
      expectedMonthlyPriceUsd * expectedBonusPercent * 1_000_000
    );

    expect(bonusTx?.amount_microdollars).toBe(expectedBonusMicrodollars);
    expect(bonusTx?.amount_microdollars).not.toBe(24_500_000);

    const auditRows = await db
      .select({ payload: kilo_pass_audit_log.payload_json })
      .from(kilo_pass_audit_log)
      .where(
        and(
          eq(kilo_pass_audit_log.action, KiloPassAuditLogAction.BonusCreditsIssued),
          eq(kilo_pass_audit_log.related_monthly_issuance_id, issuanceId)
        )
      );

    const payload = auditRows[0]?.payload ?? null;
    expect(isRecord(payload)).toBe(true);
    if (!isRecord(payload))
      throw new Error('Expected bonus issuance audit payload to be an object');

    const decision = payload.monthlyBonusDecision;
    expect(isRecord(decision)).toBe(true);
    if (!isRecord(decision)) {
      throw new Error('Expected audit payload to include monthlyBonusDecision object');
    }

    expect(decision.streakMonths).toBe(2);
    expect(decision.startedAt).toBe(startedAtIso);
    expect(decision.issueMonth).toBe('2026-02-01');
  });

  test('monthly: month-3 regression (started before cutoff) => ramp applies', async () => {
    const user = await insertTestUser({
      microdollars_used: 55_000_000,
      kilo_pass_threshold: 49_000_000,
    });

    const { issuanceId } = await seedBaseIssuance({
      kiloUserId: user.id,
      cadence: KiloPassCadence.Monthly,
      tier: KiloPassTier.Tier49,
      issueMonth: '2026-03-01',
      stripeInvoiceId: 'inv_test_monthly_month3_regression',
      currentStreakMonths: 3,
      nextYearlyIssueAt: null,
      startedAtIso: '2026-01-01T00:00:00.000Z',
    });

    await maybeIssueKiloPassBonusFromUsageThreshold({
      kiloUserId: user.id,
      nowIso: new Date('2026-03-15T00:00:00.000Z').toISOString(),
      db,
    });

    const bonusItem = await db.query.kilo_pass_issuance_items.findFirst({
      where: and(
        eq(kilo_pass_issuance_items.kilo_pass_issuance_id, issuanceId),
        eq(kilo_pass_issuance_items.kind, KiloPassIssuanceItemKind.Bonus)
      ),
    });
    expect(bonusItem).toBeTruthy();

    const bonusTx = await db.query.credit_transactions.findFirst({
      where: eq(credit_transactions.id, bonusItem?.credit_transaction_id ?? ''),
    });
    // tier_49 at streak=3 => base 5% + step 5% * 2 = 15% of $49.00 = $7.35.
    expect(bonusTx?.amount_microdollars).toBe(7_350_000);
  });

  test('monthly: issues first-month promo when eligible and clears kilo_pass_threshold', async () => {
    const user = await insertTestUser({
      microdollars_used: 20_000_000,
      kilo_pass_threshold: 19_000_000,
    });

    const { issuanceId } = await seedBaseIssuance({
      kiloUserId: user.id,
      cadence: KiloPassCadence.Monthly,
      tier: KiloPassTier.Tier19,
      issueMonth: '2026-01-01',
      stripeInvoiceId: 'inv_test_monthly_promo',
      currentStreakMonths: 1,
      nextYearlyIssueAt: null,
    });

    await maybeIssueKiloPassBonusFromUsageThreshold({
      kiloUserId: user.id,
      nowIso: new Date('2026-01-15T00:00:00.000Z').toISOString(),
      db,
    });

    const bonusItem = await db.query.kilo_pass_issuance_items.findFirst({
      where: and(
        eq(kilo_pass_issuance_items.kilo_pass_issuance_id, issuanceId),
        eq(kilo_pass_issuance_items.kind, KiloPassIssuanceItemKind.Bonus)
      ),
    });
    expect(bonusItem).toBeTruthy();

    const bonusTx = await db.query.credit_transactions.findFirst({
      where: eq(credit_transactions.id, bonusItem?.credit_transaction_id ?? ''),
    });
    expect(bonusTx?.is_free).toBe(true);
    expect(bonusTx?.description).toBe('Kilo Pass promo 50% bonus (tier_19, streak=1)');
    expect(bonusTx?.amount_microdollars).toBe(9_500_000);

    const auditRows = await db
      .select({ payload: kilo_pass_audit_log.payload_json })
      .from(kilo_pass_audit_log)
      .where(
        and(
          eq(kilo_pass_audit_log.action, KiloPassAuditLogAction.BonusCreditsIssued),
          eq(kilo_pass_audit_log.related_monthly_issuance_id, issuanceId)
        )
      );

    const payload = auditRows[0]?.payload ?? null;
    expect(isRecord(payload)).toBe(true);
    if (!isRecord(payload))
      throw new Error('Expected bonus issuance audit payload to be an object');
    expect(payload.bonusKind).toBe('promo-50pct');

    const userRow = await db.query.kilocode_users.findFirst({
      where: eq(kilocode_users.id, user.id),
    });
    expect(userRow?.kilo_pass_threshold).toBeNull();
  });

  test('monthly: tier_19 with prior subscription and streak=1 issues regular bonus (no first-time promo) and clears kilo_pass_threshold', async () => {
    const user = await insertTestUser({
      microdollars_used: 20_000_000,
      kilo_pass_threshold: 19_000_000,
    });

    // Prior subscription makes the user ineligible for the first-month promo.
    await db.insert(kilo_pass_subscriptions).values({
      kilo_user_id: user.id,
      stripe_subscription_id: `sub_prior_${Math.random()}`,
      tier: KiloPassTier.Tier19,
      cadence: KiloPassCadence.Monthly,
      status: 'canceled',
      cancel_at_period_end: false,
      started_at: new Date('2025-01-01T00:00:00.000Z').toISOString(),
      ended_at: new Date('2025-02-01T00:00:00.000Z').toISOString(),
      current_streak_months: 0,
      next_yearly_issue_at: null,
    });

    const { issuanceId } = await seedBaseIssuance({
      kiloUserId: user.id,
      cadence: KiloPassCadence.Monthly,
      tier: KiloPassTier.Tier19,
      issueMonth: '2026-01-01',
      stripeInvoiceId: 'inv_test_monthly_zero',
      currentStreakMonths: 1,
      nextYearlyIssueAt: null,
    });

    await maybeIssueKiloPassBonusFromUsageThreshold({
      kiloUserId: user.id,
      nowIso: new Date('2026-01-15T00:00:00.000Z').toISOString(),
      db,
    });

    const bonusItem = await db.query.kilo_pass_issuance_items.findFirst({
      where: and(
        eq(kilo_pass_issuance_items.kilo_pass_issuance_id, issuanceId),
        eq(kilo_pass_issuance_items.kind, KiloPassIssuanceItemKind.Bonus)
      ),
    });
    expect(bonusItem).toBeTruthy();

    const bonusTx = await db.query.credit_transactions.findFirst({
      where: eq(credit_transactions.id, bonusItem?.credit_transaction_id ?? ''),
    });
    // tier_19 at streak=1 => 5% of $19.00 = $0.95.
    expect(bonusTx?.amount_microdollars).toBe(950_000);

    const promoItems = await db
      .select({ id: kilo_pass_issuance_items.id })
      .from(kilo_pass_issuance_items)
      .where(
        and(
          eq(kilo_pass_issuance_items.kilo_pass_issuance_id, issuanceId),
          eq(kilo_pass_issuance_items.kind, KiloPassIssuanceItemKind.PromoFirstMonth50Pct)
        )
      );
    expect(promoItems).toHaveLength(0);

    const userRow = await db.query.kilocode_users.findFirst({
      where: eq(kilocode_users.id, user.id),
    });
    expect(userRow?.kilo_pass_threshold).toBeNull();
  });

  test('yearly: issues month-1 bonus (invoice issuance) when threshold is exceeded', async () => {
    const user = await insertTestUser({
      microdollars_used: 55_000_000,
      kilo_pass_threshold: 49_000_000,
    });

    const { issuanceId } = await seedBaseIssuance({
      kiloUserId: user.id,
      cadence: KiloPassCadence.Yearly,
      tier: KiloPassTier.Tier49,
      issueMonth: '2026-01-01',
      stripeInvoiceId: 'inv_test_yearly',
      currentStreakMonths: 0,
      nextYearlyIssueAt: new Date('2026-02-01T00:00:00.000Z').toISOString(),
    });

    await maybeIssueKiloPassBonusFromUsageThreshold({
      kiloUserId: user.id,
      nowIso: new Date('2026-01-15T00:00:00.000Z').toISOString(),
      db,
    });

    const bonusItem = await db.query.kilo_pass_issuance_items.findFirst({
      where: and(
        eq(kilo_pass_issuance_items.kilo_pass_issuance_id, issuanceId),
        eq(kilo_pass_issuance_items.kind, KiloPassIssuanceItemKind.Bonus)
      ),
    });
    expect(bonusItem).toBeTruthy();

    const bonusTx = await db.query.credit_transactions.findFirst({
      where: eq(credit_transactions.id, bonusItem?.credit_transaction_id ?? ''),
    });
    expect(bonusTx?.is_free).toBe(true);
    expect(bonusTx?.amount_microdollars).toBe(24_500_000);

    const userRow = await db.query.kilocode_users.findFirst({
      where: eq(kilocode_users.id, user.id),
    });
    expect(userRow?.kilo_pass_threshold).toBeNull();
  });
});
