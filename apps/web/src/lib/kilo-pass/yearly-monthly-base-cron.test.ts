import { describe, test, expect } from '@jest/globals';

import { db } from '@/lib/drizzle';
import {
  credit_transactions,
  kilo_pass_issuance_items,
  kilo_pass_issuances,
  kilo_pass_subscriptions,
  kilocode_users,
} from '@kilocode/db/schema';
import {
  KiloPassIssuanceItemKind,
  KiloPassCadence,
  KiloPassTier,
  KiloPassIssuanceSource,
} from '@/lib/kilo-pass/enums';
import { and, eq, inArray } from 'drizzle-orm';

import { insertTestUser } from '@/tests/helpers/user.helper';
import { runKiloPassYearlyMonthlyBaseCron } from '@/lib/kilo-pass/yearly-monthly-base-cron';
import { KILO_PASS_TIER_CONFIG } from '@/lib/kilo-pass/constants';
import { toMicrodollars } from '@/lib/utils';

describe('runKiloPassYearlyMonthlyBaseCron', () => {
  test('issues yearly cadence monthly base (with catch-up) and advances next_yearly_issue_at', async () => {
    const now = new Date('2026-01-06T00:00:00.000Z');
    const dueAtIso = '2025-12-01T00:00:00.000Z';

    const user = await insertTestUser();

    const inserted = await db
      .insert(kilo_pass_subscriptions)
      .values({
        kilo_user_id: user.id,
        stripe_subscription_id: `test-stripe-sub-${crypto.randomUUID()}`,
        tier: KiloPassTier.Tier49,
        cadence: KiloPassCadence.Yearly,
        status: 'active',
        started_at: now.toISOString(),
        ended_at: null,
        current_streak_months: 0,
        next_yearly_issue_at: dueAtIso,
      })
      .returning({ subscriptionId: kilo_pass_subscriptions.id });

    const subscriptionId = inserted[0]?.subscriptionId;
    expect(subscriptionId).toBeTruthy();
    if (!subscriptionId) throw new Error('Failed to insert kilo_pass_subscriptions row');

    const summary = await runKiloPassYearlyMonthlyBaseCron(db, { now });

    expect(summary.ran).toBe(true);
    expect(summary.processedSubscriptionCount).toBe(1);
    expect(summary.catchupStepCount).toBe(2);
    expect(summary.baseIssuedCount).toBe(2);
    expect(summary.nextYearlyIssueAtAdvancedCount).toBe(2);

    const updated = await db
      .select({ nextYearlyIssueAt: kilo_pass_subscriptions.next_yearly_issue_at })
      .from(kilo_pass_subscriptions)
      .where(eq(kilo_pass_subscriptions.id, subscriptionId))
      .limit(1);

    const nextYearlyIssueAt = updated[0]?.nextYearlyIssueAt;
    expect(nextYearlyIssueAt).toBeTruthy();
    if (!nextYearlyIssueAt) throw new Error('Expected next_yearly_issue_at to be set');
    expect(new Date(nextYearlyIssueAt).toISOString()).toBe('2026-02-01T00:00:00.000Z');

    const issuances = await db
      .select({ issuanceId: kilo_pass_issuances.id, issueMonth: kilo_pass_issuances.issue_month })
      .from(kilo_pass_issuances)
      .where(
        and(
          eq(kilo_pass_issuances.kilo_pass_subscription_id, subscriptionId),
          inArray(kilo_pass_issuances.issue_month, ['2025-12-01', '2026-01-01'])
        )
      )
      .limit(10);

    expect(issuances.length).toBe(2);
    const issuanceIds = issuances.map(r => r.issuanceId);

    const issuanceItems = await db
      .select({
        creditTransactionId: kilo_pass_issuance_items.credit_transaction_id,
        issuanceId: kilo_pass_issuance_items.kilo_pass_issuance_id,
      })
      .from(kilo_pass_issuance_items)
      .where(
        and(
          inArray(kilo_pass_issuance_items.kilo_pass_issuance_id, issuanceIds),
          eq(kilo_pass_issuance_items.kind, KiloPassIssuanceItemKind.Base)
        )
      )
      .limit(10);

    expect(issuanceItems.length).toBe(2);

    const creditTransactionIds = issuanceItems
      .map(i => i.creditTransactionId)
      .filter((x): x is string => Boolean(x));
    expect(creditTransactionIds.length).toBe(2);

    const credits = await db
      .select({
        amountMicrodollars: credit_transactions.amount_microdollars,
        isFree: credit_transactions.is_free,
      })
      .from(credit_transactions)
      .where(inArray(credit_transactions.id, creditTransactionIds))
      .limit(10);

    expect(credits.length).toBe(2);
    for (const c of credits) {
      expect(c.isFree).toBe(false);
      expect(c.amountMicrodollars).toBe(
        toMicrodollars(KILO_PASS_TIER_CONFIG[KiloPassTier.Tier49].monthlyPriceUsd)
      );
    }

    const userRow = await db
      .select({ threshold: kilocode_users.kilo_pass_threshold })
      .from(kilocode_users)
      .where(eq(kilocode_users.id, user.id))
      .limit(1);
    expect(userRow[0]?.threshold).toBe(
      toMicrodollars(KILO_PASS_TIER_CONFIG[KiloPassTier.Tier49].monthlyPriceUsd)
    );
  });

  test('issues credits for paused yearly subscription', async () => {
    const now = new Date('2026-02-06T00:00:00.000Z');
    const dueAtIso = '2026-01-01T00:00:00.000Z';

    const user = await insertTestUser();

    const inserted = await db
      .insert(kilo_pass_subscriptions)
      .values({
        kilo_user_id: user.id,
        stripe_subscription_id: `test-stripe-sub-${crypto.randomUUID()}`,
        tier: KiloPassTier.Tier49,
        cadence: KiloPassCadence.Yearly,
        status: 'paused',
        started_at: now.toISOString(),
        ended_at: null,
        current_streak_months: 0,
        next_yearly_issue_at: dueAtIso,
      })
      .returning({ subscriptionId: kilo_pass_subscriptions.id });

    const subscriptionId = inserted[0]?.subscriptionId;
    expect(subscriptionId).toBeTruthy();
    if (!subscriptionId) throw new Error('Failed to insert kilo_pass_subscriptions row');

    const summary = await runKiloPassYearlyMonthlyBaseCron(db, { now });

    expect(summary.ran).toBe(true);
    expect(summary.processedSubscriptionCount).toBeGreaterThanOrEqual(1);
    expect(summary.baseIssuedCount).toBeGreaterThanOrEqual(1);
  });

  test('stops issuing after 12 issuances for paused yearly subscription', async () => {
    // Place the subscription far in the past so 13+ months would be due
    const subscriptionStartedAt = '2024-12-01T00:00:00.000Z';
    // Invoice-sourced issuance at start of period (month 1 already issued by stripe invoice)
    const invoiceIssuanceMonth = '2024-12-01';
    // now is 14 months after the invoice issuance — 13 more months would be due without cap
    const now = new Date('2026-02-06T00:00:00.000Z');
    // next_yearly_issue_at = one month after the invoice issuance (month 2 onwards handled by cron)
    const dueAtIso = '2025-01-01T00:00:00.000Z';

    const user = await insertTestUser();

    const inserted = await db
      .insert(kilo_pass_subscriptions)
      .values({
        kilo_user_id: user.id,
        stripe_subscription_id: `test-stripe-sub-${crypto.randomUUID()}`,
        tier: KiloPassTier.Tier49,
        cadence: KiloPassCadence.Yearly,
        status: 'paused',
        started_at: subscriptionStartedAt,
        ended_at: null,
        current_streak_months: 0,
        next_yearly_issue_at: dueAtIso,
      })
      .returning({ subscriptionId: kilo_pass_subscriptions.id });

    const subscriptionId = inserted[0]?.subscriptionId;
    expect(subscriptionId).toBeTruthy();
    if (!subscriptionId) throw new Error('Failed to insert kilo_pass_subscriptions row');

    // Seed 1 invoice-sourced issuance (the initial yearly payment — month 1)
    await db.insert(kilo_pass_issuances).values({
      kilo_pass_subscription_id: subscriptionId,
      issue_month: invoiceIssuanceMonth,
      source: KiloPassIssuanceSource.StripeInvoice,
      stripe_invoice_id: `in_seed_invoice_${crypto.randomUUID()}`,
    });

    await runKiloPassYearlyMonthlyBaseCron(db, { now });

    // Count all issuances for this subscription
    const allIssuances = await db
      .select({ id: kilo_pass_issuances.id })
      .from(kilo_pass_issuances)
      .where(eq(kilo_pass_issuances.kilo_pass_subscription_id, subscriptionId));

    // Should never exceed 12 total issuances (1 invoice + up to 11 cron = 12 max)
    expect(allIssuances.length).toBeLessThanOrEqual(12);
  });
});
