import { expect, test } from '@jest/globals';

import { db } from '@/lib/drizzle';
import { insertTestUser } from '@/tests/helpers/user.helper';
import { dayjs } from '@/lib/kilo-pass/dayjs';
import {
  credit_transactions,
  kilo_pass_audit_log,
  kilo_pass_issuance_items,
  kilo_pass_subscriptions,
} from '@kilocode/db/schema';
import { KiloPassAuditLogResult } from './enums';
import { KiloPassAuditLogAction } from './enums';
import { KiloPassIssuanceItemKind } from './enums';
import { KiloPassIssuanceSource } from './enums';
import { KiloPassCadence } from './enums';
import { KiloPassTier } from '@/lib/kilo-pass/enums';
import { and, eq } from 'drizzle-orm';
import { forceImmediateExpirationRecomputation } from '@/lib/balanceCache';

import {
  computeIssueMonth,
  createOrGetIssuanceHeader,
  issueBaseCreditsForIssuance,
  issueBonusCreditsForIssuance,
} from './issuance';

import { KILO_PASS_TIER_CONFIG } from './constants';

async function createTestSubscription(params: {
  kiloUserId: string;
  tier: KiloPassTier;
  cadence: KiloPassCadence;
  startedAt?: string | null;
  nextYearlyIssueAt?: string | null;
}): Promise<{ subscriptionId: string }> {
  const { kiloUserId, tier, cadence, startedAt, nextYearlyIssueAt } = params;
  const stripeSubscriptionId = `stripe-sub-${kiloUserId}-${Date.now()}-${Math.random()}`;

  const inserted = await db
    .insert(kilo_pass_subscriptions)
    .values({
      kilo_user_id: kiloUserId,
      stripe_subscription_id: stripeSubscriptionId,
      tier,
      cadence,
      status: 'active',
      started_at: startedAt ?? null,
      next_yearly_issue_at: nextYearlyIssueAt ?? null,
    })
    .returning({ subscriptionId: kilo_pass_subscriptions.id });

  const row = inserted[0];
  if (!row) throw new Error('Failed to create test kilo_pass_subscription');
  return row;
}

test('base issuance is idempotent: calling twice only creates one credit_transaction', async () => {
  const user = await insertTestUser({ total_microdollars_acquired: 0, microdollars_used: 0 });
  const { subscriptionId } = await createTestSubscription({
    kiloUserId: user.id,
    tier: KiloPassTier.Tier49,
    cadence: KiloPassCadence.Monthly,
  });

  const issueMonth = computeIssueMonth(dayjs('2026-01-15T12:00:00.000Z'));
  const stripeInvoiceId = `inv-${Date.now()}-${Math.random()}`;
  const { issuanceId } = await db.transaction(async tx => {
    return await createOrGetIssuanceHeader(tx, {
      subscriptionId,
      issueMonth,
      source: KiloPassIssuanceSource.StripeInvoice,
      stripeInvoiceId,
    });
  });

  const description = `kilo-pass-base-${Date.now()}-${Math.random()}`;
  const amountUsd = KILO_PASS_TIER_CONFIG.tier_49.monthlyPriceUsd;

  const first = await db.transaction(async tx => {
    return await issueBaseCreditsForIssuance(tx, {
      issuanceId,
      subscriptionId,
      kiloUserId: user.id,
      amountUsd,
      stripeInvoiceId,
      description,
    });
  });
  expect(first.wasIssued).toBe(true);

  const second = await db.transaction(async tx => {
    return await issueBaseCreditsForIssuance(tx, {
      issuanceId,
      subscriptionId,
      kiloUserId: user.id,
      amountUsd,
      stripeInvoiceId,
      description,
    });
  });
  await forceImmediateExpirationRecomputation(user.id);
  expect(second.wasIssued).toBe(false);

  const transactions = await db
    .select({ id: credit_transactions.id })
    .from(credit_transactions)
    .where(
      and(
        eq(credit_transactions.kilo_user_id, user.id),
        eq(credit_transactions.description, description)
      )
    );
  expect(transactions).toHaveLength(1);

  const issuanceItems = await db
    .select({ id: kilo_pass_issuance_items.id })
    .from(kilo_pass_issuance_items)
    .where(
      and(
        eq(kilo_pass_issuance_items.kilo_pass_issuance_id, issuanceId),
        eq(kilo_pass_issuance_items.kind, KiloPassIssuanceItemKind.Base)
      )
    );
  expect(issuanceItems).toHaveLength(1);

  const auditRows = await db
    .select({ result: kilo_pass_audit_log.result })
    .from(kilo_pass_audit_log)
    .where(
      and(
        eq(kilo_pass_audit_log.action, KiloPassAuditLogAction.BaseCreditsIssued),
        eq(kilo_pass_audit_log.related_monthly_issuance_id, issuanceId)
      )
    );
  expect(auditRows).toHaveLength(2);
  expect(auditRows.map(r => r.result).sort()).toEqual([
    KiloPassAuditLogResult.SkippedIdempotent,
    KiloPassAuditLogResult.Success,
  ]);
});

test('createOrGetIssuanceHeader throws if the same stripeInvoiceId is reused for a different subscription/month', async () => {
  const user = await insertTestUser({ total_microdollars_acquired: 0, microdollars_used: 0 });

  const { subscriptionId: subscriptionId1 } = await createTestSubscription({
    kiloUserId: user.id,
    tier: KiloPassTier.Tier49,
    cadence: KiloPassCadence.Monthly,
  });

  const { subscriptionId: subscriptionId2 } = await createTestSubscription({
    kiloUserId: user.id,
    tier: KiloPassTier.Tier49,
    cadence: KiloPassCadence.Monthly,
  });

  const stripeInvoiceId = `inv-reuse-${Date.now()}-${Math.random()}`;
  const issueMonth1 = computeIssueMonth(dayjs('2026-01-15T12:00:00.000Z'));
  const issueMonth2 = computeIssueMonth(dayjs('2026-02-15T12:00:00.000Z'));

  await db.transaction(async tx => {
    await createOrGetIssuanceHeader(tx, {
      subscriptionId: subscriptionId1,
      issueMonth: issueMonth1,
      source: KiloPassIssuanceSource.StripeInvoice,
      stripeInvoiceId,
    });
  });

  await expect(
    db.transaction(async tx => {
      return await createOrGetIssuanceHeader(tx, {
        subscriptionId: subscriptionId2,
        issueMonth: issueMonth2,
        source: KiloPassIssuanceSource.StripeInvoice,
        stripeInvoiceId,
      });
    })
  ).rejects.toThrow(
    `createOrGetIssuanceHeader: stripeInvoiceId=${stripeInvoiceId} already exists for subscriptionId=`
  );
});

test('bonus issuance creates expiry and correct baseline microdollars_used', async () => {
  const user = await insertTestUser({ total_microdollars_acquired: 0, microdollars_used: 123 });
  const { subscriptionId } = await createTestSubscription({
    kiloUserId: user.id,
    tier: KiloPassTier.Tier49,
    cadence: KiloPassCadence.Monthly,
    startedAt: '2026-02-01T00:00:00.000Z',
  });

  const issueMonth = computeIssueMonth(dayjs('2026-02-15T12:00:00.000Z'));
  const { issuanceId } = await db.transaction(async tx => {
    return await createOrGetIssuanceHeader(tx, {
      subscriptionId,
      issueMonth,
      source: KiloPassIssuanceSource.Cron,
    });
  });

  const description = `kilo-pass-bonus-${Date.now()}-${Math.random()}`;

  const result = await db.transaction(async tx => {
    return await issueBonusCreditsForIssuance(tx, {
      issuanceId,
      subscriptionId,
      kiloUserId: user.id,
      baseAmountUsd: KILO_PASS_TIER_CONFIG.tier_49.monthlyPriceUsd,
      bonusPercentApplied: 0.1,
      description,
    });
  });

  await forceImmediateExpirationRecomputation(user.id);

  expect(result.wasIssued).toBe(true);
  expect(result.amountMicrodollars).toBe(4_900_000);

  const txId = result.creditTransactionId;
  expect(typeof txId).toBe('string');

  const creditRows = await db
    .select({
      id: credit_transactions.id,
      is_free: credit_transactions.is_free,
      expiry_date: credit_transactions.expiry_date,
      expiration_baseline_microdollars_used:
        credit_transactions.expiration_baseline_microdollars_used,
      original_baseline_microdollars_used: credit_transactions.original_baseline_microdollars_used,
      amount_microdollars: credit_transactions.amount_microdollars,
    })
    .from(credit_transactions)
    .where(eq(credit_transactions.id, txId ?? ''));

  const credit = creditRows[0];
  if (!credit) throw new Error('Expected bonus credit_transaction to exist');

  expect(credit.is_free).toBe(true);
  expect(credit.amount_microdollars).toBe(4_900_000);
  expect(credit.expiration_baseline_microdollars_used).toBe(123);
  expect(credit.original_baseline_microdollars_used).toBe(123);

  const expiry = credit.expiry_date ? new Date(credit.expiry_date) : null;
  expect(expiry instanceof Date).toBe(true);
  if (!expiry) throw new Error('Expected expiry_date to be set');

  expect(expiry.toISOString()).toBe(new Date('2026-03-01T00:00:00.000Z').toISOString());
});

test('monthly cadence: bonus expiry is end of the subscription month (period end), not month end', async () => {
  const user = await insertTestUser({ total_microdollars_acquired: 0, microdollars_used: 0 });
  const startedAt = '2025-04-04T00:00:00.000Z';

  const { subscriptionId } = await createTestSubscription({
    kiloUserId: user.id,
    tier: KiloPassTier.Tier49,
    cadence: KiloPassCadence.Monthly,
    startedAt,
  });

  const issueMonth = computeIssueMonth(dayjs('2025-04-04T00:00:00.000Z'));
  const { issuanceId } = await db.transaction(async tx => {
    return await createOrGetIssuanceHeader(tx, {
      subscriptionId,
      issueMonth,
      source: KiloPassIssuanceSource.Cron,
    });
  });

  const result = await db.transaction(async tx => {
    return await issueBonusCreditsForIssuance(tx, {
      issuanceId,
      subscriptionId,
      kiloUserId: user.id,
      baseAmountUsd: KILO_PASS_TIER_CONFIG.tier_49.monthlyPriceUsd,
      bonusPercentApplied: 0.1,
      description: `kilo-pass-bonus-expiry-monthly-${Date.now()}-${Math.random()}`,
    });
  });

  expect(result.wasIssued).toBe(true);
  expect(result.creditTransactionId).toBeTruthy();
  if (!result.creditTransactionId) throw new Error('Expected creditTransactionId to be set');

  const rows = await db
    .select({ expiry_date: credit_transactions.expiry_date })
    .from(credit_transactions)
    .where(eq(credit_transactions.id, result.creditTransactionId))
    .limit(1);

  const expiryIso = rows[0]?.expiry_date ?? null;
  expect(expiryIso).toBeTruthy();
  if (!expiryIso) throw new Error('Expected expiry_date to be set');

  // Monthly cadence credits should expire at the next Stripe billing boundary.
  // This is anchored to `started_at` (e.g. start_date), not the calendar month end.
  expect(new Date(expiryIso).toISOString()).toBe(
    new Date('2025-05-04T00:00:00.000Z').toISOString()
  );
});

test('monthly cadence: bonus expiry matches next billing boundary for every month across 5 years', async () => {
  const user = await insertTestUser({ total_microdollars_acquired: 0, microdollars_used: 0 });

  // Use dates far in the past so the promo grant logic always prefers the explicit
  // subscription-anchored expiry date over the fallback (expiry_hours based on Date.now()).
  const startedAt = '2000-01-14T00:00:00.000Z';

  const { subscriptionId } = await createTestSubscription({
    kiloUserId: user.id,
    tier: KiloPassTier.Tier49,
    cadence: KiloPassCadence.Monthly,
    startedAt,
  });

  const results = await db.transaction(async tx => {
    const start = dayjs(startedAt).utc();
    const expiries: { monthIndex: number; issueMonth: string; expiryIso: string }[] = [];

    for (let monthIndex = 0; monthIndex < 60; monthIndex += 1) {
      const issueMonth = computeIssueMonth(start.add(monthIndex, 'month'));

      const { issuanceId } = await createOrGetIssuanceHeader(tx, {
        subscriptionId,
        issueMonth,
        source: KiloPassIssuanceSource.Cron,
      });

      const result = await issueBonusCreditsForIssuance(tx, {
        issuanceId,
        subscriptionId,
        kiloUserId: user.id,
        baseAmountUsd: KILO_PASS_TIER_CONFIG.tier_49.monthlyPriceUsd,
        bonusPercentApplied: 0.1,
        description: `kilo-pass-bonus-expiry-monthly-5y:${monthIndex}:${Date.now()}:${Math.random()}`,
      });

      if (!result.creditTransactionId) {
        throw new Error(`Expected creditTransactionId to be set (monthIndex=${monthIndex})`);
      }

      const creditRow = await tx
        .select({ expiry_date: credit_transactions.expiry_date })
        .from(credit_transactions)
        .where(eq(credit_transactions.id, result.creditTransactionId))
        .limit(1);

      const expiryIso = creditRow[0]?.expiry_date ?? null;
      if (!expiryIso) {
        throw new Error(`Expected expiry_date to be set (monthIndex=${monthIndex})`);
      }

      expiries.push({ monthIndex, issueMonth, expiryIso });
    }

    return expiries;
  });

  const start = dayjs(startedAt).utc();

  for (const { monthIndex, issueMonth, expiryIso } of results) {
    const expectedIssueMonth = computeIssueMonth(start.add(monthIndex, 'month'));
    const expectedExpiryIso = start.add(monthIndex + 1, 'month').toISOString();

    expect(issueMonth).toBe(expectedIssueMonth);
    expect(new Date(expiryIso).toISOString()).toBe(new Date(expectedExpiryIso).toISOString());
  }
});

test('yearly cadence: bonus expiry is next_yearly_issue_at (end of the subscription month window)', async () => {
  const user = await insertTestUser({ total_microdollars_acquired: 0, microdollars_used: 0 });
  const startedAt = '2024-02-29T00:00:00.000Z';
  const nextYearlyIssueAt = '2024-03-29T00:00:00.000Z';

  const { subscriptionId } = await createTestSubscription({
    kiloUserId: user.id,
    tier: KiloPassTier.Tier49,
    cadence: KiloPassCadence.Yearly,
    startedAt,
    nextYearlyIssueAt,
  });

  const issueMonth = computeIssueMonth(dayjs(startedAt));
  const { issuanceId } = await db.transaction(async tx => {
    return await createOrGetIssuanceHeader(tx, {
      subscriptionId,
      issueMonth,
      source: KiloPassIssuanceSource.Cron,
    });
  });

  const result = await db.transaction(async tx => {
    return await issueBonusCreditsForIssuance(tx, {
      issuanceId,
      subscriptionId,
      kiloUserId: user.id,
      baseAmountUsd: KILO_PASS_TIER_CONFIG.tier_49.monthlyPriceUsd,
      bonusPercentApplied: 0.1,
      description: `kilo-pass-bonus-expiry-yearly-${Date.now()}-${Math.random()}`,
    });
  });

  expect(result.wasIssued).toBe(true);
  expect(result.creditTransactionId).toBeTruthy();
  if (!result.creditTransactionId) throw new Error('Expected creditTransactionId to be set');

  const rows = await db
    .select({ expiry_date: credit_transactions.expiry_date })
    .from(credit_transactions)
    .where(eq(credit_transactions.id, result.creditTransactionId))
    .limit(1);

  const expiryIso = rows[0]?.expiry_date ?? null;
  expect(expiryIso).toBeTruthy();
  if (!expiryIso) throw new Error('Expected expiry_date to be set');
  expect(new Date(expiryIso).toISOString()).toBe(new Date(nextYearlyIssueAt).toISOString());
});

test('promo 50% bonus can be issued for multiple streak months (different issuance)', async () => {
  const user = await insertTestUser({ total_microdollars_acquired: 0, microdollars_used: 0 });
  const { subscriptionId } = await createTestSubscription({
    kiloUserId: user.id,
    tier: KiloPassTier.Tier19,
    cadence: KiloPassCadence.Monthly,
  });

  const now1 = new Date('2026-03-01T00:00:00.000Z');
  const { issuanceId: issuanceId1 } = await db.transaction(async tx => {
    return await createOrGetIssuanceHeader(tx, {
      subscriptionId,
      issueMonth: computeIssueMonth(dayjs(now1)),
      source: KiloPassIssuanceSource.StripeInvoice,
      stripeInvoiceId: `inv-${Date.now()}-${Math.random()}`,
    });
  });

  const desc1 = `kilo-pass-promo-${Date.now()}-${Math.random()}`;
  const r1 = await db.transaction(async tx => {
    return await issueBonusCreditsForIssuance(tx, {
      issuanceId: issuanceId1,
      subscriptionId,
      kiloUserId: user.id,
      baseAmountUsd: KILO_PASS_TIER_CONFIG.tier_19.monthlyPriceUsd,
      bonusPercentApplied: 0.5,
      description: desc1,
      auditPayload: { bonusKind: 'promo-50pct', streakMonths: 1 },
    });
  });
  await forceImmediateExpirationRecomputation(user.id);
  expect(r1.wasIssued).toBe(true);

  const bonusItemsAfter1 = await db
    .select({ id: kilo_pass_issuance_items.id })
    .from(kilo_pass_issuance_items)
    .where(
      and(
        eq(kilo_pass_issuance_items.kilo_pass_issuance_id, issuanceId1),
        eq(kilo_pass_issuance_items.kind, KiloPassIssuanceItemKind.Bonus)
      )
    );
  expect(bonusItemsAfter1).toHaveLength(1);

  const now2 = new Date('2026-04-01T00:00:00.000Z');
  const { issuanceId: issuanceId2 } = await db.transaction(async tx => {
    return await createOrGetIssuanceHeader(tx, {
      subscriptionId,
      issueMonth: computeIssueMonth(dayjs(now2)),
      source: KiloPassIssuanceSource.Cron,
    });
  });

  const desc2 = `kilo-pass-promo-repeat-${Date.now()}-${Math.random()}`;
  const r2 = await db.transaction(async tx => {
    return await issueBonusCreditsForIssuance(tx, {
      issuanceId: issuanceId2,
      subscriptionId,
      kiloUserId: user.id,
      baseAmountUsd: KILO_PASS_TIER_CONFIG.tier_19.monthlyPriceUsd,
      bonusPercentApplied: 0.5,
      description: desc2,
      auditPayload: { bonusKind: 'promo-50pct', streakMonths: 2 },
    });
  });
  await forceImmediateExpirationRecomputation(user.id);
  expect(r2.wasIssued).toBe(true);
  expect(r2.creditTransactionId).toBeTruthy();

  const promoTransactions = await db
    .select({ id: credit_transactions.id })
    .from(credit_transactions)
    .where(
      and(eq(credit_transactions.kilo_user_id, user.id), eq(credit_transactions.description, desc2))
    );
  expect(promoTransactions).toHaveLength(1);

  const issuance2Items = await db
    .select({ id: kilo_pass_issuance_items.id })
    .from(kilo_pass_issuance_items)
    .where(
      and(
        eq(kilo_pass_issuance_items.kilo_pass_issuance_id, issuanceId2),
        eq(kilo_pass_issuance_items.kind, KiloPassIssuanceItemKind.Bonus)
      )
    );
  expect(issuance2Items).toHaveLength(1);

  const bonusItemsForIssuance1After2 = await db
    .select({ id: kilo_pass_issuance_items.id })
    .from(kilo_pass_issuance_items)
    .where(
      and(
        eq(kilo_pass_issuance_items.kilo_pass_issuance_id, issuanceId1),
        eq(kilo_pass_issuance_items.kind, KiloPassIssuanceItemKind.Bonus)
      )
    );
  expect(bonusItemsForIssuance1After2).toHaveLength(1);

  const bonusItemsForIssuance2After2 = await db
    .select({ id: kilo_pass_issuance_items.id })
    .from(kilo_pass_issuance_items)
    .where(
      and(
        eq(kilo_pass_issuance_items.kilo_pass_issuance_id, issuanceId2),
        eq(kilo_pass_issuance_items.kind, KiloPassIssuanceItemKind.Bonus)
      )
    );
  expect(bonusItemsForIssuance2After2).toHaveLength(1);

  const issuedAudits = await db
    .select({
      result: kilo_pass_audit_log.result,
      related_monthly_issuance_id: kilo_pass_audit_log.related_monthly_issuance_id,
    })
    .from(kilo_pass_audit_log)
    .where(eq(kilo_pass_audit_log.action, KiloPassAuditLogAction.BonusCreditsIssued));

  const issuedForThisUser = issuedAudits.filter(
    r =>
      r.related_monthly_issuance_id === issuanceId1 || r.related_monthly_issuance_id === issuanceId2
  );
  expect(issuedForThisUser).toHaveLength(2);
  expect(issuedForThisUser.map(r => r.result).sort()).toEqual([
    KiloPassAuditLogResult.Success,
    KiloPassAuditLogResult.Success,
  ]);
});

test('promo and bonus are mutually exclusive: parallel calls issue only one', async () => {
  // This test verifies that when promo and bonus issuance are called concurrently
  // for the same issuance, only one of them succeeds (the other is skipped).
  //
  // The concern from the code review report:
  // "Promo + bonus can both be issued under concurrent webhook delivery (non-atomic exclusivity)"
  //
  // The protection mechanism:
  // - Both `issueBonusCreditsForIssuance()` and `issueFirstMonthPromoForIssuance()` call
  //   `lockIssuanceRow()` which does `SELECT ... FOR UPDATE` on the issuance row.
  // - After acquiring the lock, each function checks for the existence of the other type.
  // - This serializes access and prevents both from being issued.
  //
  // NOTE: This test uses Promise.all() to start both transactions concurrently.
  // The FOR UPDATE lock ensures only one transaction can proceed at a time.
  // The second transaction will block until the first commits, then see the
  // first's insert and skip.

  const user = await insertTestUser({ total_microdollars_acquired: 0, microdollars_used: 0 });
  const { subscriptionId } = await createTestSubscription({
    kiloUserId: user.id,
    tier: KiloPassTier.Tier49,
    cadence: KiloPassCadence.Monthly,
  });

  const now = new Date('2026-01-15T12:00:00.000Z');
  const issueMonth = computeIssueMonth(dayjs(now));
  const { issuanceId } = await db.transaction(async tx => {
    return await createOrGetIssuanceHeader(tx, {
      subscriptionId,
      issueMonth,
      source: KiloPassIssuanceSource.StripeInvoice,
      stripeInvoiceId: `inv-concurrent-${Date.now()}-${Math.random()}`,
    });
  });

  const baseAmountUsd = KILO_PASS_TIER_CONFIG.tier_49.monthlyPriceUsd;
  const promoDescription = `kilo-pass-concurrent-promo-${Date.now()}-${Math.random()}`;
  const bonusDescription = `kilo-pass-concurrent-bonus-${Date.now()}-${Math.random()}`;

  // Run promo and bonus issuance concurrently using separate transactions.
  // Each transaction uses a different connection from the pool, allowing true concurrency.
  // The FOR UPDATE lock in lockIssuanceRow() serializes access to the issuance row.
  const [promoResult, bonusResult] = await Promise.all([
    db.transaction(async tx => {
      return await issueBonusCreditsForIssuance(tx, {
        issuanceId,
        subscriptionId,
        kiloUserId: user.id,
        baseAmountUsd,
        bonusPercentApplied: 0.5,
        description: promoDescription,
        auditPayload: { bonusKind: 'promo-50pct' },
      });
    }),
    db.transaction(async tx => {
      return await issueBonusCreditsForIssuance(tx, {
        issuanceId,
        subscriptionId,
        kiloUserId: user.id,
        baseAmountUsd,
        bonusPercentApplied: 0.1,
        description: bonusDescription,
      });
    }),
  ]);

  await forceImmediateExpirationRecomputation(user.id);

  // Exactly one should have been issued, the other should have been skipped.
  const issuedCount = [promoResult.wasIssued, bonusResult.wasIssued].filter(Boolean).length;
  expect(issuedCount).toBe(1);

  // Verify at the database level: only one of promo or bonus should exist.
  const bonusItems = await db
    .select({ id: kilo_pass_issuance_items.id })
    .from(kilo_pass_issuance_items)
    .where(
      and(
        eq(kilo_pass_issuance_items.kilo_pass_issuance_id, issuanceId),
        eq(kilo_pass_issuance_items.kind, KiloPassIssuanceItemKind.Bonus)
      )
    );

  // Mutual exclusivity is now enforced by kind-level idempotency: only one Bonus issuance item.
  expect(bonusItems).toHaveLength(1);

  const bonusAuditLogs = await db
    .select({ result: kilo_pass_audit_log.result, action: kilo_pass_audit_log.action })
    .from(kilo_pass_audit_log)
    .where(
      and(
        eq(kilo_pass_audit_log.related_monthly_issuance_id, issuanceId),
        eq(kilo_pass_audit_log.action, KiloPassAuditLogAction.BonusCreditsIssued)
      )
    );

  const bonusSkipAuditLogs = await db
    .select({ result: kilo_pass_audit_log.result })
    .from(kilo_pass_audit_log)
    .where(
      and(
        eq(kilo_pass_audit_log.related_monthly_issuance_id, issuanceId),
        eq(kilo_pass_audit_log.action, KiloPassAuditLogAction.BonusCreditsSkippedIdempotent)
      )
    );

  const bonusSucceeded = bonusAuditLogs.some(l => l.result === KiloPassAuditLogResult.Success);

  expect(bonusSucceeded).toBe(true);
  expect(bonusSkipAuditLogs.length).toBeGreaterThanOrEqual(1);
});
