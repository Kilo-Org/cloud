import {
  credit_transactions,
  kilo_pass_audit_log,
  kilo_pass_issuance_items,
  kilo_pass_issuances,
  kilo_pass_subscriptions,
  kilocode_users,
} from '@kilocode/db/schema';
import type { User } from '@kilocode/db/schema';
import { KiloPassAuditLogResult } from './enums';
import { KiloPassAuditLogAction } from './enums';
import { KiloPassCadence } from './enums';
import { KiloPassIssuanceItemKind } from './enums';
import { type KiloPassIssuanceSource } from './enums';

import type { db as defaultDb } from '@/lib/drizzle';
import { processTopUp } from '@/lib/credits';
import { grantCreditForCategory, type GrantCreditOptions } from '@/lib/promotionalCredits';
import { toMicrodollars } from '@/lib/utils';
import { and, eq } from 'drizzle-orm';

import type { DrizzleTransaction } from '@/lib/drizzle';
import { dayjs } from '@/lib/kilo-pass/dayjs';
import type { Dayjs } from 'dayjs';

type Db = typeof defaultDb;
type DbOrTx = Db | DrizzleTransaction;

export function computeIssueMonth(date: Dayjs): string {
  return date.utc().format('YYYY-MM-01');
}

async function computeKiloPassBonusExpiryDate(
  tx: DrizzleTransaction,
  params: {
    issuanceId: string;
    subscriptionId: string;
  }
): Promise<Date | null> {
  const issuanceRows = await tx
    .select({ issueMonth: kilo_pass_issuances.issue_month })
    .from(kilo_pass_issuances)
    .where(eq(kilo_pass_issuances.id, params.issuanceId))
    .limit(1);

  const issueMonth = issuanceRows[0]?.issueMonth;
  if (!issueMonth) {
    return null;
  }

  const subscriptionRows = await tx
    .select({
      cadence: kilo_pass_subscriptions.cadence,
      nextYearlyIssueAt: kilo_pass_subscriptions.next_yearly_issue_at,
      startedAt: kilo_pass_subscriptions.started_at,
    })
    .from(kilo_pass_subscriptions)
    .where(eq(kilo_pass_subscriptions.id, params.subscriptionId))
    .limit(1);

  const subscription = subscriptionRows[0];
  if (!subscription) {
    return null;
  }

  if (subscription.cadence === KiloPassCadence.Yearly) {
    const nextYearlyIssueAt = subscription.nextYearlyIssueAt;
    if (nextYearlyIssueAt != null) {
      const parsed = dayjs(nextYearlyIssueAt).utc();
      if (parsed.isValid()) {
        // For yearly cadence, monthly bonus periods are anchored to the subscription schedule.
        // `next_yearly_issue_at` represents the end of the current subscription-month period.
        return parsed.toDate();
      }
    }
  }

  if (subscription.cadence === KiloPassCadence.Monthly) {
    const startedAt = subscription.startedAt;
    if (!startedAt) {
      return null;
    }

    const startedAtUtc = dayjs(startedAt).utc();
    if (!startedAtUtc.isValid()) {
      return null;
    }

    const issueMonthStartUtc = dayjs(`${issueMonth}T00:00:00.000Z`).utc();
    if (!issueMonthStartUtc.isValid()) {
      return null;
    }

    const startedAtMonthStartUtc = startedAtUtc.startOf('month');
    const monthOffset = issueMonthStartUtc.diff(startedAtMonthStartUtc, 'month');

    if (monthOffset < 0) {
      return null;
    }

    // For monthly cadence, bonus credits expire at the next Stripe billing boundary.
    // We approximate the billing boundary by anchoring to `started_at` and advancing by whole months.
    const currentPeriodStartUtc = startedAtUtc.add(monthOffset, 'month');
    const currentPeriodEndUtc = currentPeriodStartUtc.add(1, 'month');
    return currentPeriodEndUtc.toDate();
  }

  return null;
}

type AppendKiloPassAuditLogParams = {
  action: KiloPassAuditLogAction;
  result: KiloPassAuditLogResult;
  kiloUserId?: string | null;
  kiloPassSubscriptionId?: string | null;
  idempotencyKey?: string | null;
  stripeEventId?: string | null;
  stripeInvoiceId?: string | null;
  stripeSubscriptionId?: string | null;
  relatedCreditTransactionId?: string | null;
  relatedMonthlyIssuanceId?: string | null;
  payload?: Record<string, unknown>;
};

export async function appendKiloPassAuditLog(
  db: DbOrTx,
  params: AppendKiloPassAuditLogParams
): Promise<void> {
  const {
    action,
    result,
    kiloUserId,
    kiloPassSubscriptionId,
    idempotencyKey,
    stripeEventId,
    stripeInvoiceId,
    stripeSubscriptionId,
    relatedCreditTransactionId,
    relatedMonthlyIssuanceId,
    payload,
  } = params;

  await db.insert(kilo_pass_audit_log).values({
    action,
    result,
    kilo_user_id: kiloUserId ?? null,
    kilo_pass_subscription_id: kiloPassSubscriptionId ?? null,
    idempotency_key: idempotencyKey ?? null,
    stripe_event_id: stripeEventId ?? null,
    stripe_invoice_id: stripeInvoiceId ?? null,
    stripe_subscription_id: stripeSubscriptionId ?? null,
    related_credit_transaction_id: relatedCreditTransactionId ?? null,
    related_monthly_issuance_id: relatedMonthlyIssuanceId ?? null,
    payload_json: payload ?? {},
  });
}

export async function createOrGetIssuanceHeader(
  tx: DrizzleTransaction,
  params: {
    subscriptionId: string;
    issueMonth: string;
    source: KiloPassIssuanceSource;
    stripeInvoiceId?: string | null;
  }
): Promise<{ issuanceId: string; wasCreated: boolean }> {
  const { subscriptionId, issueMonth, source, stripeInvoiceId } = params;

  const insertResult = await tx
    .insert(kilo_pass_issuances)
    .values({
      kilo_pass_subscription_id: subscriptionId,
      issue_month: issueMonth,
      source,
      stripe_invoice_id: stripeInvoiceId ?? null,
    })
    .onConflictDoNothing()
    .returning({ issuanceId: kilo_pass_issuances.id });

  const insertedIssuanceId = insertResult[0]?.issuanceId;
  if (insertedIssuanceId) {
    return { issuanceId: insertedIssuanceId, wasCreated: true };
  }

  const bySubscriptionMonth = await tx
    .select({ issuanceId: kilo_pass_issuances.id })
    .from(kilo_pass_issuances)
    .where(
      and(
        eq(kilo_pass_issuances.kilo_pass_subscription_id, subscriptionId),
        eq(kilo_pass_issuances.issue_month, issueMonth)
      )
    )
    .limit(1);

  const existingIssuanceId = bySubscriptionMonth[0]?.issuanceId;
  if (existingIssuanceId) {
    return { issuanceId: existingIssuanceId, wasCreated: false };
  }

  if (stripeInvoiceId) {
    const byInvoice = await tx
      .select({
        issuanceId: kilo_pass_issuances.id,
        subscriptionId: kilo_pass_issuances.kilo_pass_subscription_id,
        issueMonth: kilo_pass_issuances.issue_month,
      })
      .from(kilo_pass_issuances)
      .where(eq(kilo_pass_issuances.stripe_invoice_id, stripeInvoiceId))
      .limit(1);

    const existing = byInvoice[0];
    if (existing) {
      if (existing.subscriptionId !== subscriptionId || existing.issueMonth !== issueMonth) {
        throw new Error(
          `createOrGetIssuanceHeader: stripeInvoiceId=${stripeInvoiceId} already exists for subscriptionId=${existing.subscriptionId} issueMonth=${existing.issueMonth}, but was requested for subscriptionId=${subscriptionId} issueMonth=${issueMonth}`
        );
      }

      return { issuanceId: existing.issuanceId, wasCreated: false };
    }
  }

  throw new Error(
    `createOrGetIssuanceHeader: issuance not found after conflict for subscriptionId=${subscriptionId} issueMonth=${issueMonth}`
  );
}

function roundUsdToCents(usd: number): number {
  return Math.round(usd * 100);
}

function centsToUsd(cents: number): number {
  return cents / 100;
}

async function lockIssuanceRow(tx: DrizzleTransaction, issuanceId: string): Promise<void> {
  const lockRows = await tx
    .select({ issuanceId: kilo_pass_issuances.id })
    .from(kilo_pass_issuances)
    .where(eq(kilo_pass_issuances.id, issuanceId))
    .for('update')
    .limit(1);

  if (lockRows.length === 0) {
    throw new Error(`Issuance not found: ${issuanceId}`);
  }
}

export { lockIssuanceRow };

async function getExistingIssuanceItem(
  tx: DrizzleTransaction,
  params: {
    issuanceId: string;
    kind: KiloPassIssuanceItemKind;
  }
): Promise<{
  issuanceItemId: string;
  creditTransactionId: string;
} | null> {
  const { issuanceId, kind } = params;
  const rows = await tx
    .select({
      issuanceItemId: kilo_pass_issuance_items.id,
      creditTransactionId: kilo_pass_issuance_items.credit_transaction_id,
    })
    .from(kilo_pass_issuance_items)
    .where(
      and(
        eq(kilo_pass_issuance_items.kilo_pass_issuance_id, issuanceId),
        eq(kilo_pass_issuance_items.kind, kind)
      )
    )
    .limit(1);

  const row = rows[0];
  if (!row) return null;
  return row;
}

async function getUserForCreditMutations(
  tx: DrizzleTransaction,
  kiloUserId: string
): Promise<User> {
  const rows = await tx
    .select()
    .from(kilocode_users)
    .where(eq(kilocode_users.id, kiloUserId))
    .limit(1);
  const user = rows[0];
  if (!user) {
    throw new Error(`User not found: ${kiloUserId}`);
  }
  return user;
}

export type IssueCreditResult = {
  wasIssued: boolean;
  issuanceItemId: string | null;
  creditTransactionId: string | null;
  amountUsd: number;
  amountMicrodollars: number;
};

export async function issueBaseCreditsForIssuance(
  tx: DrizzleTransaction,
  params: {
    issuanceId: string;
    subscriptionId: string;
    kiloUserId: string;
    amountUsd: number;
    /**
     * The Stripe Invoice ID here is used as the Stripe Payment ID for `processTopUp`.
     * Even though it isn't a payment ID, it's good enough because it's guaranteed to be unique.
     */
    stripeInvoiceId: string;
    description: string;
  }
): Promise<IssueCreditResult> {
  const { issuanceId, subscriptionId, kiloUserId, amountUsd, stripeInvoiceId, description } =
    params;

  await lockIssuanceRow(tx, issuanceId);

  const existing = await getExistingIssuanceItem(tx, {
    issuanceId,
    kind: KiloPassIssuanceItemKind.Base,
  });

  if (existing) {
    await appendKiloPassAuditLog(tx, {
      action: KiloPassAuditLogAction.BaseCreditsIssued,
      result: KiloPassAuditLogResult.SkippedIdempotent,
      kiloUserId,
      kiloPassSubscriptionId: subscriptionId,
      stripeInvoiceId,
      relatedCreditTransactionId: existing.creditTransactionId,
      relatedMonthlyIssuanceId: issuanceId,
      payload: { reason: 'issuance_item_already_exists', kind: KiloPassIssuanceItemKind.Base },
    });

    return {
      wasIssued: false,
      issuanceItemId: existing.issuanceItemId,
      creditTransactionId: existing.creditTransactionId,
      amountUsd,
      amountMicrodollars: 0,
    };
  }

  const user = await getUserForCreditMutations(tx, kiloUserId);
  const originalBaselineMicrodollarsUsed = user.microdollars_used;
  const amountCents = roundUsdToCents(amountUsd);
  const amountMicrodollars = toMicrodollars(centsToUsd(amountCents));

  // Use processTopUp() as the canonical way to create paid credits, while keeping
  // Kilo Pass issuance atomic by executing on the same transaction.
  const attemptedCreditTransactionId = crypto.randomUUID();
  const topUpOk = await processTopUp(
    user,
    amountCents,
    {
      type: 'stripe',
      stripe_payment_id: stripeInvoiceId,
    },
    {
      dbOrTx: tx,
      creditTransactionId: attemptedCreditTransactionId,
      creditDescription: description,
      skipPostTopUpFreeStuff: true,
    }
  );

  const creditTransactionId = topUpOk
    ? attemptedCreditTransactionId
    : (
        await tx
          .select({ id: credit_transactions.id })
          .from(credit_transactions)
          .where(eq(credit_transactions.stripe_payment_id, stripeInvoiceId))
          .limit(1)
      )[0]?.id;

  if (!creditTransactionId) {
    throw new Error(
      `processTopUp returned ok=${topUpOk} but no credit_transactions row exists (stripe_payment_id=${stripeInvoiceId})`
    );
  }

  const issuanceItemInsert = await tx
    .insert(kilo_pass_issuance_items)
    .values({
      kilo_pass_issuance_id: issuanceId,
      kind: KiloPassIssuanceItemKind.Base,
      credit_transaction_id: creditTransactionId,
      amount_usd: centsToUsd(amountCents),
      bonus_percent_applied: null,
    })
    .returning({ issuanceItemId: kilo_pass_issuance_items.id });

  const issuanceItemId = issuanceItemInsert[0]?.issuanceItemId;
  if (!issuanceItemId) {
    throw new Error('Failed to insert issuance item for base credits');
  }

  await appendKiloPassAuditLog(tx, {
    action: KiloPassAuditLogAction.BaseCreditsIssued,
    result: topUpOk ? KiloPassAuditLogResult.Success : KiloPassAuditLogResult.SkippedIdempotent,
    kiloUserId,
    kiloPassSubscriptionId: subscriptionId,
    stripeInvoiceId,
    relatedCreditTransactionId: creditTransactionId,
    relatedMonthlyIssuanceId: issuanceId,
    payload: {
      kind: KiloPassIssuanceItemKind.Base,
      amountUsd: centsToUsd(amountCents),
      stripeInvoiceId,
      originalBaselineMicrodollarsUsed,
    },
  });

  return {
    wasIssued: topUpOk,
    issuanceItemId,
    creditTransactionId,
    amountUsd: centsToUsd(amountCents),
    amountMicrodollars: topUpOk ? amountMicrodollars : 0,
  };
}

export async function issueBonusCreditsForIssuance(
  tx: DrizzleTransaction,
  params: {
    issuanceId: string;
    subscriptionId: string;
    kiloUserId: string;
    baseAmountUsd: number;
    bonusPercentApplied: number;
    stripeInvoiceId?: string | null;
    description: string;
    auditPayload?: Record<string, unknown>;
  }
): Promise<IssueCreditResult> {
  const {
    issuanceId,
    subscriptionId,
    kiloUserId,
    baseAmountUsd,
    bonusPercentApplied,
    stripeInvoiceId,
    description,
    auditPayload,
  } = params;

  const withAuditPayload = (payload: Record<string, unknown>): Record<string, unknown> => {
    if (!auditPayload) return payload;

    return {
      ...payload,
      ...auditPayload,
    };
  };

  await lockIssuanceRow(tx, issuanceId);

  const existing = await getExistingIssuanceItem(tx, {
    issuanceId,
    kind: KiloPassIssuanceItemKind.Bonus,
  });

  if (existing) {
    await appendKiloPassAuditLog(tx, {
      action: KiloPassAuditLogAction.BonusCreditsSkippedIdempotent,
      result: KiloPassAuditLogResult.SkippedIdempotent,
      kiloUserId,
      kiloPassSubscriptionId: subscriptionId,
      stripeInvoiceId: stripeInvoiceId ?? null,
      relatedCreditTransactionId: existing.creditTransactionId,
      relatedMonthlyIssuanceId: issuanceId,
      payload: withAuditPayload({
        reason: 'issuance_item_already_exists',
        kind: KiloPassIssuanceItemKind.Bonus,
      }),
    });

    return {
      wasIssued: false,
      issuanceItemId: existing.issuanceItemId,
      creditTransactionId: existing.creditTransactionId,
      amountUsd: 0,
      amountMicrodollars: 0,
    };
  }

  const existingPromo = await getExistingIssuanceItem(tx, {
    issuanceId,
    kind: KiloPassIssuanceItemKind.PromoFirstMonth50Pct,
  });

  if (existingPromo) {
    await appendKiloPassAuditLog(tx, {
      action: KiloPassAuditLogAction.BonusCreditsSkippedIdempotent,
      result: KiloPassAuditLogResult.SkippedIdempotent,
      kiloUserId,
      kiloPassSubscriptionId: subscriptionId,
      stripeInvoiceId: stripeInvoiceId ?? null,
      relatedMonthlyIssuanceId: issuanceId,
      payload: withAuditPayload({
        reason: 'existing_promo_item',
        promoIssuanceItemId: existingPromo.issuanceItemId,
      }),
    });

    return {
      wasIssued: false,
      issuanceItemId: null,
      creditTransactionId: null,
      amountUsd: 0,
      amountMicrodollars: 0,
    };
  }

  const user = await getUserForCreditMutations(tx, kiloUserId);
  const baseCents = roundUsdToCents(baseAmountUsd);
  const bonusCents = Math.round(baseCents * bonusPercentApplied);
  const bonusUsd = centsToUsd(bonusCents);
  const bonusMicrodollars = toMicrodollars(centsToUsd(bonusCents));

  const creditExpiryDate = await computeKiloPassBonusExpiryDate(tx, {
    issuanceId,
    subscriptionId,
  });

  const creditCategory = 'kilo-pass-bonus';
  const options = {
    credit_category: creditCategory,
    counts_as_selfservice: false,
    amount_usd: bonusUsd,
    description,
    credit_expiry_date: creditExpiryDate ?? undefined,
    dbOrTx: tx,
  } satisfies GrantCreditOptions;

  const grantResult = await grantCreditForCategory(user, options);
  if (!grantResult.success) {
    throw new Error(`Failed to grant bonus credits: ${grantResult.message}`);
  }

  const creditTransactionId = grantResult.credit_transaction_id;

  const issuanceItemInsert = await tx
    .insert(kilo_pass_issuance_items)
    .values({
      kilo_pass_issuance_id: issuanceId,
      kind: KiloPassIssuanceItemKind.Bonus,
      credit_transaction_id: creditTransactionId,
      amount_usd: bonusUsd,
      bonus_percent_applied: bonusPercentApplied,
    })
    .returning({ issuanceItemId: kilo_pass_issuance_items.id });

  const issuanceItemId = issuanceItemInsert[0]?.issuanceItemId;
  if (!issuanceItemId) {
    throw new Error('Failed to insert issuance item for bonus credits');
  }

  await appendKiloPassAuditLog(tx, {
    action: KiloPassAuditLogAction.BonusCreditsIssued,
    result: KiloPassAuditLogResult.Success,
    kiloUserId,
    kiloPassSubscriptionId: subscriptionId,
    stripeInvoiceId: stripeInvoiceId ?? null,
    relatedCreditTransactionId: creditTransactionId,
    relatedMonthlyIssuanceId: issuanceId,
    payload: withAuditPayload({
      kind: KiloPassIssuanceItemKind.Bonus,
      baseAmountUsd: centsToUsd(baseCents),
      bonusPercentApplied,
      bonusAmountUsd: bonusUsd,
      creditCategory,
    }),
  });

  return {
    wasIssued: true,
    issuanceItemId,
    creditTransactionId,
    amountUsd: bonusUsd,
    amountMicrodollars: bonusMicrodollars,
  };
}
