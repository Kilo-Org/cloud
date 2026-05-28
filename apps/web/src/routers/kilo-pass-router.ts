import { baseProcedure, createTRPCRouter } from '@/lib/trpc/init';
import { captureException } from '@sentry/nextjs';
import { db, readDb } from '@/lib/drizzle';
import { getKiloPassStateForUser, type KiloPassSubscriptionState } from '@/lib/kilo-pass/state';
import { client as stripe } from '@/lib/stripe-client';
import { getStripePriceIdForKiloPass } from '@/lib/kilo-pass/stripe-price-ids.server';
import { getAffiliateAttribution } from '@/lib/affiliate-attribution';
import { APP_URL } from '@/lib/constants';
import { TRPCError } from '@trpc/server';
import {
  credit_transactions,
  kilo_pass_issuance_items,
  kilo_pass_issuances,
  kilo_pass_scheduled_changes,
  kilo_pass_store_purchases,
  kilo_pass_subscriptions,
  microdollar_usage,
  microdollar_usage_daily,
} from '@kilocode/db/schema';
import {
  KiloPassCadence,
  KiloPassAuditLogAction,
  KiloPassAuditLogResult,
  KiloPassScheduledChangeStatus,
  KiloPassTier,
  KiloPassPaymentProvider,
  KiloPassWelcomePromoEligibilityReason,
} from '@/lib/kilo-pass/enums';
import { KiloPassIssuanceItemKind } from '@/lib/kilo-pass/enums';
import { and, asc, desc, eq, inArray, isNull, ne, sql, sum } from 'drizzle-orm';
import * as z from 'zod';
import {
  computeMonthlyCadenceBonusPercent,
  computeYearlyCadenceMonthlyBonusUsd,
  getMonthlyPriceUsd,
} from '@/lib/kilo-pass/bonus';
import { KiloPassError } from '@/lib/kilo-pass/errors';
import { isStripeSubscriptionEnded } from '@/lib/kilo-pass/stripe-subscription-status';
import { releaseScheduledChangeForSubscription } from '@/lib/kilo-pass/scheduled-change-release';
import { appendKiloPassAuditLog } from '@/lib/kilo-pass/issuance';
import {
  KILO_PASS_MONTHLY_FIRST_2_MONTHS_PROMO_CUTOFF,
  KILO_PASS_TIER_CONFIG,
} from '@/lib/kilo-pass/constants';
import { fromMicrodollars } from '@/lib/utils';
import { timedUsageQuery } from '@/lib/usage-query';
import {
  billingHistoryResponseSchema,
  mapStripeInvoiceToBillingHistoryEntry,
} from '@/lib/subscriptions/subscription-center';
import type Stripe from 'stripe';
import { dayjs } from '@/lib/kilo-pass/dayjs';
import { computeChurnkeyAuthHash } from '@/lib/churnkey/auth';
import { closePauseEvent } from '@/lib/kilo-pass/pause-events';
import { getAllMobileStoreKiloPassProducts } from '@/lib/kilo-pass/mobile-store-products';
import { verifyAppleKiloPassTransactionJws } from '@/lib/kilo-pass/apple-store-verifier';
import { completeStoreKiloPassPurchase } from '@/lib/kilo-pass/store-subscription-completion';

const CursorInputSchema = z.object({
  cursor: z.string().nullable().optional(),
  limit: z.number().int().min(1).max(100).optional(),
});

const KiloPassCreditHistoryEntrySchema = z.object({
  id: z.string(),
  date: z.string(),
  amountUsd: z.number(),
  kind: z.enum([
    KiloPassIssuanceItemKind.Base,
    KiloPassIssuanceItemKind.Bonus,
    KiloPassIssuanceItemKind.PromoFirstMonth50Pct,
    KiloPassIssuanceItemKind.ReferralBonus,
  ]),
  description: z.string(),
});

const KiloPassCreditHistoryResponseSchema = z.object({
  entries: z.array(KiloPassCreditHistoryEntrySchema),
  hasMore: z.boolean(),
  cursor: z.string().nullable(),
});

function parseOffsetCursor(cursor: string | null | undefined): number {
  if (!cursor) return 0;

  const parsed = Number.parseInt(cursor, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

const KiloPassTierSchema = z.enum(KiloPassTier);

const KiloPassCadenceSchema = z.enum(KiloPassCadence);
const KiloPassPaymentProviderSchema = z.enum(KiloPassPaymentProvider);

const KiloPassSubscriptionStatusSchema = z.union([
  z.literal('active'),
  z.literal('canceled'),
  z.literal('incomplete'),
  z.literal('incomplete_expired'),
  z.literal('past_due'),
  z.literal('paused'),
  z.literal('trialing'),
  z.literal('unpaid'),
]);

const KiloPassSubscriptionStateBaseSchema = z.object({
  subscriptionId: z.string(),
  stripeSubscriptionId: z.string().nullable(),
  paymentProvider: KiloPassPaymentProviderSchema,
  providerSubscriptionId: z.string().nullable(),
  tier: KiloPassTierSchema,
  cadence: KiloPassCadenceSchema,
  status: KiloPassSubscriptionStatusSchema,
  cancelAtPeriodEnd: z.boolean(),
  currentStreakMonths: z.number(),
  nextYearlyIssueAt: z.string().nullable(),
  startedAt: z.string().nullable(),
  resumesAt: z.string().nullable(),
});

const KiloPassSubscriptionStateSchema = KiloPassSubscriptionStateBaseSchema.extend({
  nextBonusCreditsUsd: z.number().nullable(),
  nextBillingAt: z.string().nullable(),

  /** True if the user has never had any other Kilo Pass subscription. */
  isFirstTimeSubscriberEver: z.boolean(),

  /** Derived, per-current-period values used for the profile card UI */
  currentPeriodBaseCreditsUsd: z.number(),
  currentPeriodUsageUsd: z.number(),
  currentPeriodHostingCostUsd: z.number(),
  currentPeriodBonusCreditsUsd: z.number().nullable(),
  isBonusUnlocked: z.boolean(),
  refillAt: z.string().nullable(),
});

const GetStateOutputSchema = z.object({
  subscription: KiloPassSubscriptionStateSchema.nullable(),
  isEligibleForFirstMonthPromo: z.boolean(),
});

const GetAverageMonthlyUsageLast3MonthsOutputSchema = z.object({
  averageMonthlyUsageUsd: z.number(),
});

const CompleteStorePurchaseOutputSchema = z.object({
  subscriptionId: z.string(),
  tier: KiloPassTierSchema,
  cadence: KiloPassCadenceSchema,
  alreadyProcessed: z.boolean(),
});

type KiloPassSubscriptionStateResponse = z.infer<typeof KiloPassSubscriptionStateSchema>;

type KiloPassCreditHistoryRow = {
  id: string;
  kind: KiloPassIssuanceItemKind;
  amountUsd: number;
  createdAt: string;
  description: string | null;
};

type StripeManagedKiloPassSubscription = KiloPassSubscriptionState & {
  paymentProvider: typeof KiloPassPaymentProvider.Stripe;
  stripeSubscriptionId: string;
};

const APP_STORE_ACCOUNT_TOKEN_MISMATCH_MESSAGE =
  'App Store purchase account token does not match the signed-in user.';
const APP_STORE_PURCHASE_NOT_LINKED_TO_ACCOUNT_MESSAGE =
  "This App Store purchase isn't linked to your Kilo account. Make sure you're signed in to the Apple ID that made the purchase, then try again.";

function assertAppStoreAccountTokenMatchesUser(params: {
  appAccountToken: string | null;
  userAppStoreAccountToken: string;
}): void {
  if (params.appAccountToken === null) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: APP_STORE_PURCHASE_NOT_LINKED_TO_ACCOUNT_MESSAGE,
    });
  }
  if (params.appAccountToken !== params.userAppStoreAccountToken) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: APP_STORE_ACCOUNT_TOKEN_MISMATCH_MESSAGE,
    });
  }
}

function mapAppStoreCompletionError(error: unknown, userId: string): TRPCError {
  if (error instanceof TRPCError) {
    return error;
  }

  captureException(error, {
    tags: {
      area: 'kilo-pass',
      operation: 'complete-app-store-purchase',
    },
    extra: {
      kiloUserId: userId,
    },
  });

  const message = error instanceof Error ? error.message : '';
  const isVerifierFailure =
    message.startsWith('Apple ') || message.includes('transaction') || message.includes('product');
  const isDomainFailure =
    message.includes('already belongs') ||
    message.includes('already have an active Kilo Pass subscription') ||
    message.includes('previous period expiration');

  if (isVerifierFailure) {
    return new TRPCError({
      code: 'BAD_REQUEST',
      message: 'We could not verify this App Store purchase. Please try again.',
    });
  }

  if (isDomainFailure) {
    return new TRPCError({
      code: 'BAD_REQUEST',
      message: 'This App Store purchase cannot be used for your account.',
    });
  }

  return new TRPCError({
    code: 'INTERNAL_SERVER_ERROR',
    message: 'We could not finish this App Store purchase. Please try again.',
  });
}

function isTwoMonthPromoOfferActive(): boolean {
  return dayjs().utc().isBefore(KILO_PASS_MONTHLY_FIRST_2_MONTHS_PROMO_CUTOFF);
}

function roundToCents(usd: number): number {
  return Math.round(usd * 100) / 100;
}

function secondsToIso(seconds: number): string {
  return dayjs.unix(seconds).utc().toISOString();
}

function normalizeTimestampToIso(timestamp: string | null | undefined): string | null {
  if (!timestamp) return null;
  const parsed = dayjs(timestamp).utc();
  return parsed.isValid() ? parsed.toISOString() : timestamp;
}

function getNextBillingAtFromSubscriptionStart(subscription: {
  cadence: KiloPassCadence;
  startedAt: string | null;
}): string | null {
  const startedAtUtc = subscription.startedAt ? dayjs(subscription.startedAt).utc() : null;
  if (startedAtUtc?.isValid() !== true) return null;

  return startedAtUtc
    .add(1, subscription.cadence === KiloPassCadence.Yearly ? 'year' : 'month')
    .toISOString();
}

function getNextKiloPassBonusCreditsUsd(params: {
  subscription: KiloPassSubscriptionState;
  baseAmountUsd: number;
  isFirstTimeSubscriberEver: boolean;
}): number {
  if (params.subscription.cadence === KiloPassCadence.Yearly) {
    return roundToCents(computeYearlyCadenceMonthlyBonusUsd(params.subscription.tier));
  }

  const predictedStreakMonths = Math.max(1, params.subscription.currentStreakMonths + 1);
  const bonusPercentApplied = computeMonthlyCadenceBonusPercent({
    tier: params.subscription.tier,
    streakMonths: predictedStreakMonths,
    isFirstTimeSubscriberEver: params.isFirstTimeSubscriberEver,
    subscriptionStartedAtIso: params.subscription.startedAt,
  });

  const baseCents = Math.round(params.baseAmountUsd * 100);
  const bonusCents = Math.round(baseCents * bonusPercentApplied);
  return bonusCents / 100;
}

function getCurrentKiloPassBonusCreditsUsd(params: {
  subscription: KiloPassSubscriptionState;
  baseAmountUsd: number;
  isFirstTimeSubscriberEver: boolean;
}): number {
  if (params.subscription.cadence === KiloPassCadence.Yearly) {
    return roundToCents(computeYearlyCadenceMonthlyBonusUsd(params.subscription.tier));
  }

  const streakMonths = Math.max(1, params.subscription.currentStreakMonths);
  const bonusPercentApplied = computeMonthlyCadenceBonusPercent({
    tier: params.subscription.tier,
    streakMonths,
    isFirstTimeSubscriberEver: params.isFirstTimeSubscriberEver,
    subscriptionStartedAtIso: params.subscription.startedAt,
  });
  const cents = Math.round(params.baseAmountUsd * bonusPercentApplied * 100);
  return cents / 100;
}

function getUsageStartInclusiveIso(params: {
  subscription: KiloPassSubscriptionState;
  baseCreditsIssuedAtIso: string | null;
  periodStartIso: string;
  nowUtc: ReturnType<typeof dayjs>;
}): string {
  let usageStartInclusiveIso = params.baseCreditsIssuedAtIso ?? params.periodStartIso;
  if (params.subscription.cadence !== KiloPassCadence.Yearly) {
    return usageStartInclusiveIso;
  }

  const nextYearlyIssueAtUtc =
    params.subscription.nextYearlyIssueAt != null
      ? dayjs(params.subscription.nextYearlyIssueAt).utc()
      : null;

  if (nextYearlyIssueAtUtc?.isValid() && params.nowUtc.isBefore(nextYearlyIssueAtUtc)) {
    usageStartInclusiveIso = nextYearlyIssueAtUtc.subtract(1, 'month').toISOString();
  } else if (params.subscription.startedAt != null) {
    const startedAtUtc = dayjs(params.subscription.startedAt).utc();
    if (startedAtUtc.isValid()) {
      const monthsElapsed = Math.max(0, params.nowUtc.diff(startedAtUtc, 'month'));
      usageStartInclusiveIso = startedAtUtc.add(monthsElapsed, 'month').toISOString();
    }
  }

  return usageStartInclusiveIso;
}

function getStripePeriodEndSeconds(subscription: Stripe.Subscription): number | null {
  return subscription.items.data[0]?.current_period_end ?? null;
}

function getStripePeriodStartSeconds(subscription: Stripe.Subscription): number | null {
  return subscription.items.data[0]?.current_period_start ?? null;
}

async function getIsFirstTimeSubscriberEver(params: {
  kiloUserId: string;
  subscriptionId: string;
}): Promise<boolean> {
  const otherSubscriptions = await db
    .select({ id: kilo_pass_subscriptions.id })
    .from(kilo_pass_subscriptions)
    .where(
      and(
        eq(kilo_pass_subscriptions.kilo_user_id, params.kiloUserId),
        ne(kilo_pass_subscriptions.id, params.subscriptionId)
      )
    )
    .limit(1);

  return otherSubscriptions.length === 0;
}

function assertStripeManagedSubscription(
  subscription: KiloPassSubscriptionState
): asserts subscription is StripeManagedKiloPassSubscription {
  if (
    subscription.paymentProvider !== KiloPassPaymentProvider.Stripe ||
    !subscription.stripeSubscriptionId
  ) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'Manage this Kilo Pass subscription through the mobile app store.',
    });
  }
}

async function getIsBonusUnlockedForSubscriptionId(subscriptionId: string): Promise<boolean> {
  const lastIssuance = await db
    .select({ id: kilo_pass_issuances.id })
    .from(kilo_pass_issuances)
    .where(eq(kilo_pass_issuances.kilo_pass_subscription_id, subscriptionId))
    .orderBy(desc(kilo_pass_issuances.issue_month))
    .limit(1);

  const issuanceId = lastIssuance[0]?.id;
  if (!issuanceId) return false;

  const unlockedItem = await db.query.kilo_pass_issuance_items.findFirst({
    columns: { id: true },
    where: and(
      eq(kilo_pass_issuance_items.kilo_pass_issuance_id, issuanceId),
      inArray(kilo_pass_issuance_items.kind, [
        KiloPassIssuanceItemKind.Bonus,
        KiloPassIssuanceItemKind.PromoFirstMonth50Pct,
        KiloPassIssuanceItemKind.ReferralBonus,
      ])
    ),
  });

  return Boolean(unlockedItem);
}

/**
 * Get the timestamp when base credits were issued for the most recent issuance of a subscription.
 *
 * The Kilo Pass usage window should start from when base credits were actually issued (via the
 * invoice.paid webhook), not from Stripe's `current_period_start`. There is often a gap between
 * these two timestamps during which usage is served from pre-existing credits, not pass credits.
 */
async function getBaseCreditsIssuedAtForSubscription(
  subscriptionId: string
): Promise<string | null> {
  const rows = await db
    .select({ createdAt: credit_transactions.created_at })
    .from(kilo_pass_issuance_items)
    .innerJoin(
      kilo_pass_issuances,
      eq(kilo_pass_issuance_items.kilo_pass_issuance_id, kilo_pass_issuances.id)
    )
    .innerJoin(
      credit_transactions,
      eq(kilo_pass_issuance_items.credit_transaction_id, credit_transactions.id)
    )
    .where(
      and(
        eq(kilo_pass_issuances.kilo_pass_subscription_id, subscriptionId),
        eq(kilo_pass_issuance_items.kind, KiloPassIssuanceItemKind.Base)
      )
    )
    .orderBy(desc(kilo_pass_issuances.issue_month))
    .limit(1);

  const row = rows[0];
  if (!row?.createdAt) return null;

  const parsed = dayjs(row.createdAt).utc();
  return parsed.isValid() ? parsed.toISOString() : null;
}

async function getKiloPassIssuanceCreditHistoryRows(
  subscriptionId: string
): Promise<KiloPassCreditHistoryRow[]> {
  return db
    .select({
      id: kilo_pass_issuance_items.id,
      kind: kilo_pass_issuance_items.kind,
      amountUsd: kilo_pass_issuance_items.amount_usd,
      createdAt: credit_transactions.created_at,
      description: credit_transactions.description,
    })
    .from(kilo_pass_issuance_items)
    .innerJoin(
      kilo_pass_issuances,
      eq(kilo_pass_issuance_items.kilo_pass_issuance_id, kilo_pass_issuances.id)
    )
    .innerJoin(
      credit_transactions,
      eq(kilo_pass_issuance_items.credit_transaction_id, credit_transactions.id)
    )
    .where(eq(kilo_pass_issuances.kilo_pass_subscription_id, subscriptionId));
}

async function getStoreUpgradeCreditHistoryRows(params: {
  kiloUserId: string;
  subscriptionId: string;
  paymentProvider: KiloPassPaymentProvider;
}): Promise<KiloPassCreditHistoryRow[]> {
  const providerTransactionCreditPrefix = sql<string>`('kilo-pass:' || ${kilo_pass_store_purchases.payment_provider} || ':' || ${kilo_pass_store_purchases.provider_transaction_id})`;
  const upgradeRefundCategory = sql<string>`('kilo-pass-upgrade-refund:' || ${kilo_pass_store_purchases.payment_provider} || ':' || ${kilo_pass_store_purchases.provider_transaction_id})`;
  const upgradeBonusCategoryPrefix = sql<string>`('kilo-pass-upgrade-bonus-reversal:' || ${kilo_pass_store_purchases.payment_provider} || ':' || ${kilo_pass_store_purchases.provider_transaction_id} || ':%')`;
  const upgradePromoCategoryPrefix = sql<string>`('kilo-pass-upgrade-bonus-reversal:' || ${kilo_pass_store_purchases.payment_provider} || ':' || ${kilo_pass_store_purchases.provider_transaction_id} || ':' || ${KiloPassIssuanceItemKind.PromoFirstMonth50Pct} || ':%')`;

  const [displacedBaseRows, adjustmentRows] = await Promise.all([
    db
      .select({
        id: credit_transactions.id,
        kind: sql<KiloPassIssuanceItemKind>`${KiloPassIssuanceItemKind.Base}`,
        amountMicrodollars: credit_transactions.amount_microdollars,
        createdAt: credit_transactions.created_at,
        description: credit_transactions.description,
      })
      .from(credit_transactions)
      .innerJoin(
        kilo_pass_store_purchases,
        and(
          eq(kilo_pass_store_purchases.kilo_pass_subscription_id, params.subscriptionId),
          eq(kilo_pass_store_purchases.kilo_user_id, params.kiloUserId),
          eq(kilo_pass_store_purchases.payment_provider, params.paymentProvider),
          sql`${credit_transactions.stripe_payment_id} = ${providerTransactionCreditPrefix}`
        )
      )
      .where(
        and(
          eq(credit_transactions.kilo_user_id, params.kiloUserId),
          isNull(credit_transactions.organization_id),
          sql`${credit_transactions.amount_microdollars} > 0`,
          sql`NOT EXISTS (
            SELECT 1
            FROM kilo_pass_issuance_items
            WHERE kilo_pass_issuance_items.credit_transaction_id = ${credit_transactions.id}
          )`
        )
      ),
    db
      .select({
        id: credit_transactions.id,
        kind: sql<KiloPassIssuanceItemKind>`CASE
          WHEN ${credit_transactions.credit_category} LIKE ${upgradePromoCategoryPrefix}
            THEN ${KiloPassIssuanceItemKind.PromoFirstMonth50Pct}
          WHEN ${credit_transactions.credit_category} LIKE ${upgradeBonusCategoryPrefix}
            THEN ${KiloPassIssuanceItemKind.Bonus}
          ELSE ${KiloPassIssuanceItemKind.Base}
        END`,
        amountMicrodollars: credit_transactions.amount_microdollars,
        createdAt: credit_transactions.created_at,
        description: credit_transactions.description,
      })
      .from(credit_transactions)
      .innerJoin(
        kilo_pass_store_purchases,
        and(
          eq(kilo_pass_store_purchases.kilo_pass_subscription_id, params.subscriptionId),
          eq(kilo_pass_store_purchases.kilo_user_id, params.kiloUserId),
          eq(kilo_pass_store_purchases.payment_provider, params.paymentProvider),
          sql`(${credit_transactions.credit_category} = ${upgradeRefundCategory}
            OR ${credit_transactions.credit_category} LIKE ${upgradeBonusCategoryPrefix})`
        )
      )
      .where(
        and(
          eq(credit_transactions.kilo_user_id, params.kiloUserId),
          isNull(credit_transactions.organization_id)
        )
      ),
  ]);

  return [...displacedBaseRows, ...adjustmentRows].map(row => ({
    id: row.id,
    kind: row.kind,
    amountUsd: roundToCents(fromMicrodollars(row.amountMicrodollars)),
    createdAt: row.createdAt,
    description: row.description,
  }));
}

async function getCurrentPeriodUsageUsd(params: {
  kiloUserId: string;
  startInclusiveIso: string;
  endExclusiveIso: string;
}): Promise<number> {
  // Use primary (db) not replica: this drives the subscription-state response
  // shown immediately after usage writes, so staleness would misstate billing.
  const result = await timedUsageQuery(
    {
      db,
      route: 'kiloPass.getState',
      queryLabel: 'kilo_pass_period_usage',
      scope: 'user',
      period: `${params.startInclusiveIso}/${params.endExclusiveIso}`,
    },
    tx =>
      tx
        .select({
          totalCost_mUsd: sql<unknown>`COALESCE(${sum(microdollar_usage.cost)}, 0)`,
        })
        .from(microdollar_usage)
        .where(
          and(
            eq(microdollar_usage.kilo_user_id, params.kiloUserId),
            isNull(microdollar_usage.organization_id),
            sql`${microdollar_usage.created_at} >= ${params.startInclusiveIso}`,
            sql`${microdollar_usage.created_at} < ${params.endExclusiveIso}`
          )
        )
  );

  const raw = Number(result[0]?.totalCost_mUsd);
  const totalCost_mUsd = isNaN(raw) ? 0 : raw;
  return roundToCents(fromMicrodollars(totalCost_mUsd));
}

/**
 * Sum KiloClaw credit deductions (negative credit_transactions with a
 * `kiloclaw-subscription` category prefix) within a time window. Returns a
 * positive USD value representing hosting costs in the period.
 */
async function getCurrentPeriodHostingCostUsd(params: {
  kiloUserId: string;
  startInclusiveIso: string;
  endExclusiveIso: string;
}): Promise<number> {
  const result = await db
    .select({
      totalDeduction_mUsd: sql<unknown>`COALESCE(${sum(
        sql`ABS(${credit_transactions.amount_microdollars})`
      )}, 0)`,
    })
    .from(credit_transactions)
    .where(
      and(
        eq(credit_transactions.kilo_user_id, params.kiloUserId),
        isNull(credit_transactions.organization_id),
        sql`${credit_transactions.amount_microdollars} < 0`,
        sql`${credit_transactions.credit_category} LIKE 'kiloclaw-subscription%'`,
        sql`${credit_transactions.created_at} >= ${params.startInclusiveIso}`,
        sql`${credit_transactions.created_at} < ${params.endExclusiveIso}`
      )
    );

  const raw = Number(result[0]?.totalDeduction_mUsd);
  const totalDeduction_mUsd = isNaN(raw) ? 0 : raw;
  return roundToCents(fromMicrodollars(totalDeduction_mUsd));
}

async function getCurrentPeriodSpendUsd(params: {
  kiloUserId: string;
  startInclusiveIso: string;
  endExclusiveIso: string;
}): Promise<{
  currentPeriodUsageUsd: number;
  currentPeriodHostingCostUsd: number;
}> {
  const [currentPeriodInferenceUsageUsd, currentPeriodHostingCostUsdValue] = await Promise.all([
    getCurrentPeriodUsageUsd({
      kiloUserId: params.kiloUserId,
      startInclusiveIso: params.startInclusiveIso,
      endExclusiveIso: params.endExclusiveIso,
    }),
    getCurrentPeriodHostingCostUsd({
      kiloUserId: params.kiloUserId,
      startInclusiveIso: params.startInclusiveIso,
      endExclusiveIso: params.endExclusiveIso,
    }),
  ]);

  return {
    currentPeriodUsageUsd: roundToCents(
      currentPeriodInferenceUsageUsd + currentPeriodHostingCostUsdValue
    ),
    currentPeriodHostingCostUsd: currentPeriodHostingCostUsdValue,
  };
}

async function buildActiveKiloPassSubscriptionState(params: {
  kiloUserId: string;
  subscription: KiloPassSubscriptionState;
  periodStartIso: string;
  spendEndExclusiveIso: string;
  nextBillingAt: string | null;
  nowUtc: ReturnType<typeof dayjs>;
}): Promise<KiloPassSubscriptionStateResponse> {
  const baseAmountUsd = getMonthlyPriceUsd(params.subscription.tier);
  const isFirstTimeSubscriberEver = await getIsFirstTimeSubscriberEver({
    kiloUserId: params.kiloUserId,
    subscriptionId: params.subscription.subscriptionId,
  });
  const [isBonusUnlocked, baseCreditsIssuedAtIso] = await Promise.all([
    getIsBonusUnlockedForSubscriptionId(params.subscription.subscriptionId),
    getBaseCreditsIssuedAtForSubscription(params.subscription.subscriptionId),
  ]);
  const usageStartInclusiveIso = getUsageStartInclusiveIso({
    subscription: params.subscription,
    baseCreditsIssuedAtIso,
    periodStartIso: params.periodStartIso,
    nowUtc: params.nowUtc,
  });
  const { currentPeriodUsageUsd, currentPeriodHostingCostUsd } = await getCurrentPeriodSpendUsd({
    kiloUserId: params.kiloUserId,
    startInclusiveIso: usageStartInclusiveIso,
    endExclusiveIso: params.spendEndExclusiveIso,
  });

  return {
    ...params.subscription,
    nextBonusCreditsUsd: getNextKiloPassBonusCreditsUsd({
      subscription: params.subscription,
      baseAmountUsd,
      isFirstTimeSubscriberEver,
    }),
    nextBillingAt: params.nextBillingAt,
    isFirstTimeSubscriberEver,
    currentPeriodBaseCreditsUsd: baseAmountUsd,
    currentPeriodUsageUsd,
    currentPeriodHostingCostUsd,
    currentPeriodBonusCreditsUsd: getCurrentKiloPassBonusCreditsUsd({
      subscription: params.subscription,
      baseAmountUsd,
      isFirstTimeSubscriberEver,
    }),
    isBonusUnlocked,
    refillAt:
      params.subscription.cadence === KiloPassCadence.Yearly
        ? (params.subscription.nextYearlyIssueAt ?? params.nextBillingAt)
        : params.nextBillingAt,
  };
}

async function buildEndedKiloPassSubscriptionState(params: {
  kiloUserId: string;
  subscription: KiloPassSubscriptionState;
  status: Stripe.Subscription.Status;
}): Promise<KiloPassSubscriptionStateResponse> {
  const baseAmountUsd = getMonthlyPriceUsd(params.subscription.tier);
  const isFirstTimeSubscriberEver = await getIsFirstTimeSubscriberEver({
    kiloUserId: params.kiloUserId,
    subscriptionId: params.subscription.subscriptionId,
  });

  return {
    ...params.subscription,
    status: params.status,
    nextBonusCreditsUsd: null,
    nextBillingAt: null,
    isFirstTimeSubscriberEver,
    currentPeriodBaseCreditsUsd: baseAmountUsd,
    currentPeriodUsageUsd: 0,
    currentPeriodHostingCostUsd: 0,
    currentPeriodBonusCreditsUsd: null,
    isBonusUnlocked: false,
    refillAt: null,
  };
}

const GetCheckoutReturnStateOutputSchema = z.object({
  subscription: KiloPassSubscriptionStateBaseSchema.nullable(),
  creditsAwarded: z.boolean(),
  welcomePromoIneligibleDueToReusedFingerprint: z.boolean(),
});

const CreateCheckoutSessionInputSchema = z.object({
  tier: KiloPassTierSchema,
  cadence: KiloPassCadenceSchema,
});

const CreateCheckoutSessionOutputSchema = z.object({
  url: z.url().nullable(),
});

const CancelSubscriptionOutputSchema = z.object({
  success: z.boolean(),
});

const ScheduleChangeInputSchema = z.object({
  targetTier: KiloPassTierSchema,
  targetCadence: KiloPassCadenceSchema,
});

const ScheduleChangeOutputSchema = z.object({
  scheduledChangeId: z.string(),
  effectiveAt: z.string(),
});

const CancelScheduledChangeOutputSchema = z.object({
  success: z.boolean(),
});

const ScheduledChangeStatusSchema = z.enum(KiloPassScheduledChangeStatus);

const GetScheduledChangeOutputSchema = z.object({
  scheduledChange: z
    .object({
      id: z.string(),
      fromTier: KiloPassTierSchema,
      fromCadence: KiloPassCadenceSchema,
      toTier: KiloPassTierSchema,
      toCadence: KiloPassCadenceSchema,
      effectiveAt: z.string(),
      status: ScheduledChangeStatusSchema,
    })
    .nullable(),
});

export const kiloPassRouter = createTRPCRouter({
  getMobileStoreProducts: baseProcedure.query(({ ctx }) => ({
    appAccountToken: ctx.user.app_store_account_token,
    products: getAllMobileStoreKiloPassProducts(),
  })),

  completeAppStorePurchase: baseProcedure
    .input(z.object({ signedTransactionJws: z.string().min(1) }))
    .output(CompleteStorePurchaseOutputSchema)
    .mutation(async ({ ctx, input }) => {
      try {
        const purchase = await verifyAppleKiloPassTransactionJws(input.signedTransactionJws);
        assertAppStoreAccountTokenMatchesUser({
          appAccountToken: purchase.appAccountToken,
          userAppStoreAccountToken: ctx.user.app_store_account_token,
        });
        return await completeStoreKiloPassPurchase({ user: ctx.user, purchase });
      } catch (error) {
        throw mapAppStoreCompletionError(error, ctx.user.id);
      }
    }),

  getAverageMonthlyUsageLast3Months: baseProcedure
    .output(GetAverageMonthlyUsageLast3MonthsOutputSchema)
    .query(async ({ ctx }) => {
      const result = await timedUsageQuery(
        {
          db: readDb,
          route: 'kiloPass.getAverageMonthlyUsageLast3Months',
          queryLabel: 'kilo_pass_avg_3mo_usage',
          scope: 'user',
          period: '3months',
        },
        tx =>
          tx
            .select({
              totalCost_mUsd: sql<unknown>`COALESCE(${sum(microdollar_usage_daily.total_cost_microdollars)}, 0)`,
            })
            .from(microdollar_usage_daily)
            .where(
              and(
                eq(microdollar_usage_daily.kilo_user_id, ctx.user.id),
                isNull(microdollar_usage_daily.organization_id),
                sql`${microdollar_usage_daily.usage_date} >= (CURRENT_DATE - INTERVAL '3 months')::date`
              )
            )
      );

      const totalCostRaw = Number(result[0]?.totalCost_mUsd);
      const totalCost_mUsd = isNaN(totalCostRaw) ? 0 : totalCostRaw;

      const averageMonthlyUsageUsd = roundToCents(fromMicrodollars(totalCost_mUsd) / 3);
      return { averageMonthlyUsageUsd };
    }),

  getState: baseProcedure.output(GetStateOutputSchema).query(async ({ ctx }) => {
    const subscriptionBase = await getKiloPassStateForUser(db, ctx.user.id);
    if (!subscriptionBase) {
      return { subscription: null, isEligibleForFirstMonthPromo: isTwoMonthPromoOfferActive() };
    }

    if (subscriptionBase.paymentProvider !== KiloPassPaymentProvider.Stripe) {
      if (isStripeSubscriptionEnded(subscriptionBase.status)) {
        return {
          subscription: await buildEndedKiloPassSubscriptionState({
            kiloUserId: ctx.user.id,
            subscription: subscriptionBase,
            status: subscriptionBase.status,
          }),
          isEligibleForFirstMonthPromo: false,
        };
      }

      const latestStorePurchase = await db.query.kilo_pass_store_purchases.findFirst({
        where: and(
          eq(kilo_pass_store_purchases.kilo_pass_subscription_id, subscriptionBase.subscriptionId),
          eq(kilo_pass_store_purchases.payment_provider, subscriptionBase.paymentProvider)
        ),
        orderBy: desc(kilo_pass_store_purchases.purchased_at),
      });
      const nextBillingAt =
        normalizeTimestampToIso(latestStorePurchase?.expires_at) ??
        getNextBillingAtFromSubscriptionStart(subscriptionBase);
      const nowUtc = dayjs().utc();
      const nowIso = nowUtc.toISOString();
      const subscription = await buildActiveKiloPassSubscriptionState({
        kiloUserId: ctx.user.id,
        subscription: subscriptionBase,
        periodStartIso:
          normalizeTimestampToIso(latestStorePurchase?.purchased_at) ??
          subscriptionBase.startedAt ??
          nowIso,
        spendEndExclusiveIso: nowIso,
        nextBillingAt,
        nowUtc,
      });

      return {
        subscription,
        isEligibleForFirstMonthPromo: false,
      };
    }

    assertStripeManagedSubscription(subscriptionBase);

    const stripeCustomerId = ctx.user.stripe_customer_id;
    if (!stripeCustomerId) {
      throw new TRPCError({ code: 'BAD_REQUEST', message: 'Missing Stripe customer for user.' });
    }

    const stripeSubscription = await stripe.subscriptions.retrieve(
      subscriptionBase.stripeSubscriptionId
    );

    if (isStripeSubscriptionEnded(stripeSubscription.status)) {
      return {
        subscription: await buildEndedKiloPassSubscriptionState({
          kiloUserId: ctx.user.id,
          subscription: subscriptionBase,
          status: stripeSubscription.status,
        }),
        isEligibleForFirstMonthPromo: false,
      };
    }

    const periodEndSeconds = getStripePeriodEndSeconds(stripeSubscription);
    if (typeof periodEndSeconds !== 'number') {
      throw new KiloPassError(
        `Stripe subscription missing billing period end: subscription=${stripeSubscription.id} status=${stripeSubscription.status}`,
        {
          kilo_user_id: ctx.user.id,
          stripe_subscription_id: stripeSubscription.id,
        }
      );
    }

    const periodStartSeconds = getStripePeriodStartSeconds(stripeSubscription);
    if (typeof periodStartSeconds !== 'number') {
      throw new KiloPassError(
        `Stripe subscription missing billing period start: subscription=${stripeSubscription.id} status=${stripeSubscription.status}`,
        {
          kilo_user_id: ctx.user.id,
          stripe_subscription_id: stripeSubscription.id,
        }
      );
    }

    const nextBillingAt = secondsToIso(periodEndSeconds);
    const nowUtc = dayjs().utc();
    const nowIso = nowUtc.toISOString();
    const subscription = await buildActiveKiloPassSubscriptionState({
      kiloUserId: ctx.user.id,
      subscription: subscriptionBase,
      periodStartIso: secondsToIso(periodStartSeconds),
      spendEndExclusiveIso: nowIso,
      nextBillingAt,
      nowUtc,
    });

    return {
      subscription,
      isEligibleForFirstMonthPromo: false,
    };
  }),

  /**
   * Intended for the Stripe Checkout return flow: poll until the subscription exists and
   * we've issued the initial base credits for that subscription.
   */
  getCheckoutReturnState: baseProcedure
    .input(z.object({ sessionId: z.string().min(1) }))
    .output(GetCheckoutReturnStateOutputSchema)
    .query(async ({ ctx, input }) => {
      const subscription = await getKiloPassStateForUser(db, ctx.user.id);
      if (!subscription) {
        return {
          subscription: null,
          creditsAwarded: false,
          welcomePromoIneligibleDueToReusedFingerprint: false,
        };
      }

      const checkoutSession = await stripe.checkout.sessions.retrieve(input.sessionId);
      const stripeSubscription = checkoutSession.subscription;
      const stripeSubscriptionId =
        typeof stripeSubscription === 'string' ? stripeSubscription : stripeSubscription?.id;
      if (!stripeSubscriptionId) {
        return {
          subscription: null,
          creditsAwarded: false,
          welcomePromoIneligibleDueToReusedFingerprint: false,
        };
      }

      const settledSubscription = await db.query.kilo_pass_subscriptions.findFirst({
        columns: { id: true },
        where: and(
          eq(kilo_pass_subscriptions.kilo_user_id, ctx.user.id),
          eq(kilo_pass_subscriptions.stripe_subscription_id, stripeSubscriptionId)
        ),
      });
      if (!settledSubscription) {
        return {
          subscription: null,
          creditsAwarded: false,
          welcomePromoIneligibleDueToReusedFingerprint: false,
        };
      }

      const issuedBaseCredits = await db
        .select({
          id: kilo_pass_issuance_items.id,
          welcomePromoEligibilityReason:
            kilo_pass_issuances.initial_welcome_promo_eligibility_reason,
        })
        .from(kilo_pass_issuance_items)
        .innerJoin(
          kilo_pass_issuances,
          eq(kilo_pass_issuance_items.kilo_pass_issuance_id, kilo_pass_issuances.id)
        )
        .where(
          and(
            eq(kilo_pass_issuances.kilo_pass_subscription_id, settledSubscription.id),
            eq(kilo_pass_issuance_items.kind, KiloPassIssuanceItemKind.Base)
          )
        )
        .orderBy(asc(kilo_pass_issuances.issue_month))
        .limit(1);

      return {
        subscription,
        creditsAwarded: issuedBaseCredits.length > 0,
        welcomePromoIneligibleDueToReusedFingerprint:
          issuedBaseCredits[0]?.welcomePromoEligibilityReason ===
          KiloPassWelcomePromoEligibilityReason.FingerprintPreviouslyClaimed,
      };
    }),

  getCustomerPortalUrl: baseProcedure
    .input(
      z.object({
        returnUrl: z.url().optional(),
      })
    )
    .output(z.object({ url: z.url() }))
    .mutation(async ({ input, ctx }) => {
      const stripeCustomerId = ctx.user.stripe_customer_id;
      if (!stripeCustomerId) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Missing Stripe customer for user.' });
      }

      const subscription = await getKiloPassStateForUser(db, ctx.user.id);
      if (subscription) {
        assertStripeManagedSubscription(subscription);
      }

      const session = await stripe.billingPortal.sessions.create({
        customer: stripeCustomerId,
        return_url: input.returnUrl ?? `${APP_URL}/profile`,
      });

      return { url: session.url };
    }),

  cancelSubscription: baseProcedure
    .output(CancelSubscriptionOutputSchema)
    .mutation(async ({ ctx }) => {
      const stripeCustomerId = ctx.user.stripe_customer_id;
      if (!stripeCustomerId) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Missing Stripe customer for user.' });
      }

      const subscription = await getKiloPassStateForUser(db, ctx.user.id);
      if (!subscription) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'No Kilo Pass subscription found.' });
      }
      assertStripeManagedSubscription(subscription);

      // Can only cancel active subscriptions that aren't already pending cancellation
      if (subscription.status !== 'active' || subscription.cancelAtPeriodEnd) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Kilo Pass subscription is not currently active.',
        });
      }

      const scheduledChange = await db.query.kilo_pass_scheduled_changes.findFirst({
        columns: {
          stripe_schedule_id: true,
        },
        where: and(
          eq(kilo_pass_scheduled_changes.stripe_subscription_id, subscription.stripeSubscriptionId),
          isNull(kilo_pass_scheduled_changes.deleted_at)
        ),
      });

      if (scheduledChange) {
        await releaseScheduledChangeForSubscription({
          dbOrTx: db,
          stripe,
          stripeSubscriptionId: subscription.stripeSubscriptionId,
          stripeScheduleIdIfMissingRow: scheduledChange.stripe_schedule_id,
          kiloUserIdIfMissingRow: ctx.user.id,
          reason: 'cancel_subscription',
        });
      }

      await stripe.subscriptions.update(subscription.stripeSubscriptionId, {
        cancel_at_period_end: true,
      });

      const updated = await db
        .update(kilo_pass_subscriptions)
        .set({ cancel_at_period_end: true })
        .where(
          eq(kilo_pass_subscriptions.stripe_subscription_id, subscription.stripeSubscriptionId)
        )
        .returning({ id: kilo_pass_subscriptions.id });

      if (updated.length === 0) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to update Kilo Pass subscription status.',
        });
      }

      return { success: true };
    }),

  resumeCancelledSubscription: baseProcedure
    .output(CancelSubscriptionOutputSchema)
    .mutation(async ({ ctx }) => {
      const stripeCustomerId = ctx.user.stripe_customer_id;
      if (!stripeCustomerId) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Missing Stripe customer for user.' });
      }

      const subscription = await getKiloPassStateForUser(db, ctx.user.id);
      if (!subscription) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'No Kilo Pass subscription found.' });
      }
      assertStripeManagedSubscription(subscription);

      if (!subscription.cancelAtPeriodEnd) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Kilo Pass subscription is not pending cancellation.',
        });
      }

      if (isStripeSubscriptionEnded(subscription.status)) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Kilo Pass subscription has already ended.',
        });
      }

      await stripe.subscriptions.update(subscription.stripeSubscriptionId, {
        cancel_at_period_end: false,
      });

      const updated = await db
        .update(kilo_pass_subscriptions)
        .set({ cancel_at_period_end: false, ended_at: null })
        .where(
          eq(kilo_pass_subscriptions.stripe_subscription_id, subscription.stripeSubscriptionId)
        )
        .returning({ id: kilo_pass_subscriptions.id });

      if (updated.length === 0) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to update Kilo Pass subscription status.',
        });
      }

      return { success: true };
    }),

  resumePausedSubscription: baseProcedure
    .output(CancelSubscriptionOutputSchema)
    .mutation(async ({ ctx }) => {
      const stripeCustomerId = ctx.user.stripe_customer_id;
      if (!stripeCustomerId) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Missing Stripe customer for user.' });
      }

      const subscription = await getKiloPassStateForUser(db, ctx.user.id);
      if (!subscription) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'No Kilo Pass subscription found.' });
      }
      assertStripeManagedSubscription(subscription);

      if (subscription.status !== 'paused') {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Subscription is not paused.',
        });
      }

      // Clear pause_collection on Stripe to resume immediately
      await stripe.subscriptions.update(subscription.stripeSubscriptionId, {
        pause_collection: '',
      });

      // Close the open pause event so the UI reflects the change immediately.
      // The state query derives paused status from open pause events, so closing
      // it is sufficient — no need to update the DB status column directly.
      await closePauseEvent(db, {
        kiloPassSubscriptionId: subscription.subscriptionId,
        resumedAt: new Date().toISOString(),
      });

      return { success: true };
    }),

  getScheduledChange: baseProcedure
    .output(GetScheduledChangeOutputSchema)
    .query(async ({ ctx }) => {
      const subscription = await getKiloPassStateForUser(db, ctx.user.id);
      if (!subscription) {
        return { scheduledChange: null };
      }
      if (subscription.paymentProvider !== KiloPassPaymentProvider.Stripe) {
        return { scheduledChange: null };
      }
      assertStripeManagedSubscription(subscription);

      const scheduledChange = await db.query.kilo_pass_scheduled_changes.findFirst({
        columns: {
          id: true,
          from_tier: true,
          from_cadence: true,
          to_tier: true,
          to_cadence: true,
          effective_at: true,
          status: true,
        },
        where: and(
          eq(kilo_pass_scheduled_changes.stripe_subscription_id, subscription.stripeSubscriptionId),
          isNull(kilo_pass_scheduled_changes.deleted_at)
        ),
      });

      if (!scheduledChange) {
        return { scheduledChange: null };
      }

      return {
        scheduledChange: {
          id: scheduledChange.id,
          fromTier: scheduledChange.from_tier,
          fromCadence: scheduledChange.from_cadence,
          toTier: scheduledChange.to_tier,
          toCadence: scheduledChange.to_cadence,
          effectiveAt: scheduledChange.effective_at,
          status: scheduledChange.status,
        },
      };
    }),

  scheduleChange: baseProcedure
    .input(ScheduleChangeInputSchema)
    .output(ScheduleChangeOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const subscription = await getKiloPassStateForUser(db, ctx.user.id);
      if (!subscription) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'No Kilo Pass subscription found.' });
      }
      assertStripeManagedSubscription(subscription);

      // Only allow scheduling changes for active subscriptions.
      if (subscription.status !== 'active') {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: `Kilo Pass subscription is not active (status=${subscription.status}).`,
        });
      }

      const fromTier = subscription.tier;
      const fromCadence = subscription.cadence;
      const toTier = input.targetTier;
      const toCadence = input.targetCadence;

      if (fromTier === toTier && fromCadence === toCadence) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Target tier/cadence matches current subscription.',
        });
      }

      const fromPrice = KILO_PASS_TIER_CONFIG[fromTier].monthlyPriceUsd;
      const toPrice = KILO_PASS_TIER_CONFIG[toTier].monthlyPriceUsd;
      const isDowntier = toPrice < fromPrice;
      const isUptier = toPrice > fromPrice;
      const isCadenceChange = fromCadence !== toCadence;
      const shouldUseBillingCycleEnd =
        isCadenceChange || isDowntier || (isUptier && fromCadence === KiloPassCadence.Monthly);

      let effectiveAtIso: string;
      let effectiveAtUnix: number;

      if (shouldUseBillingCycleEnd) {
        const stripeSubscription = await stripe.subscriptions.retrieve(
          subscription.stripeSubscriptionId
        );
        const periodEndSeconds = getStripePeriodEndSeconds(stripeSubscription);
        if (typeof periodEndSeconds !== 'number') {
          throw new KiloPassError(
            `Stripe subscription missing billing period end: subscription=${stripeSubscription.id} status=${stripeSubscription.status}`,
            {
              kilo_user_id: ctx.user.id,
              stripe_subscription_id: stripeSubscription.id,
            }
          );
        }

        effectiveAtIso = secondsToIso(periodEndSeconds);
        effectiveAtUnix = periodEndSeconds;
      } else {
        const nextYearlyIssueAt = subscription.nextYearlyIssueAt ?? null;
        if (!nextYearlyIssueAt) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message:
              'Kilo Pass yearly subscription is missing next_yearly_issue_at; cannot schedule change.',
          });
        }

        const parsed = dayjs(nextYearlyIssueAt).utc();
        if (!parsed.isValid()) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: `Invalid next_yearly_issue_at timestamp: ${nextYearlyIssueAt}`,
          });
        }

        effectiveAtIso = parsed.toISOString();
        effectiveAtUnix = parsed.unix();
      }

      // If there is already an active (non-deleted) schedule for this subscription, release it first.
      // Soft-delete our DB row first; if Stripe release fails we revert.
      await releaseScheduledChangeForSubscription({
        dbOrTx: db,
        stripe,
        stripeSubscriptionId: subscription.stripeSubscriptionId,
        kiloUserIdIfMissingRow: ctx.user.id,
        reason: 'schedule_change_replace',
      });

      // Stripe schedule creation (two-phase schedule; switch price at effectiveAt).
      const currentPriceId = getStripePriceIdForKiloPass({ tier: fromTier, cadence: fromCadence });
      const targetPriceId = getStripePriceIdForKiloPass({ tier: toTier, cadence: toCadence });

      const scheduledChangeId = crypto.randomUUID();
      const metadata = {
        type: 'kilo-pass',
        kiloUserId: ctx.user.id,
        tier: toTier,
        cadence: toCadence,
        kiloPassScheduledChangeId: scheduledChangeId,
      };

      let stripeScheduleId: string | null = null;
      try {
        const schedule = await stripe.subscriptionSchedules.create({
          from_subscription: subscription.stripeSubscriptionId,
        });

        stripeScheduleId = schedule.id;
        const currentPhaseStartDate = schedule.current_phase?.start_date;
        if (typeof currentPhaseStartDate !== 'number') {
          throw new Error(
            `Stripe subscription schedule missing phases[0].start_date (schedule=${schedule.id})`
          );
        }

        const newPhase: Stripe.SubscriptionScheduleUpdateParams.Phase = {
          items: [{ price: targetPriceId, quantity: 1 }],
          start_date: effectiveAtUnix,
          metadata,
          proration_behavior: 'none',
        };

        // Cadence changes need a billing cycle reset so Stripe generates an invoice
        // for the new cadence at the transition point. Yearly tier upgrades start a
        // fresh billing cycle too — remaining credits at the old tier are issued via
        // maybeIssueYearlyRemainingCredits when the new invoice is paid.
        if (isCadenceChange || (isUptier && fromCadence === KiloPassCadence.Yearly)) {
          newPhase.billing_cycle_anchor = 'phase_start';
        }

        const updatedSchedule = await stripe.subscriptionSchedules.update(schedule.id, {
          metadata: { origin: 'kilo-pass-switch' },
          // We want the subscription to continue normally after the final phase starts.
          // Without this, Stripe may require the last phase to specify `duration`/`end_date`.
          end_behavior: 'release',
          phases: [
            {
              items: [{ price: currentPriceId, quantity: 1 }],
              start_date: currentPhaseStartDate,
              end_date: effectiveAtUnix,
            },
            newPhase,
          ],
        });

        const insertValues = {
          id: scheduledChangeId,
          kilo_user_id: ctx.user.id,
          stripe_subscription_id: subscription.stripeSubscriptionId,
          from_tier: fromTier,
          from_cadence: fromCadence,
          to_tier: toTier,
          to_cadence: toCadence,
          stripe_schedule_id: schedule.id,
          effective_at: effectiveAtIso,
          status: updatedSchedule.status as KiloPassScheduledChangeStatus,
          deleted_at: null,
        };

        await db.insert(kilo_pass_scheduled_changes).values(insertValues);

        await appendKiloPassAuditLog(db, {
          action: KiloPassAuditLogAction.StripeWebhookReceived,
          result: KiloPassAuditLogResult.Success,
          kiloUserId: ctx.user.id,
          stripeSubscriptionId: subscription.stripeSubscriptionId,
          payload: {
            scope: 'kilo_pass_scheduled_change',
            type: 'subscription_schedule.created',
            scheduledChangeId,
            scheduleId: schedule.id,
            scheduleStatus: updatedSchedule.status,
            fromTier,
            fromCadence,
            toTier,
            toCadence,
            effectiveAt: effectiveAtIso,
          },
        });

        return { scheduledChangeId, effectiveAt: effectiveAtIso };
      } catch (error) {
        // Best-effort cleanup: if we created a schedule but failed after that, release it.
        if (stripeScheduleId) {
          await releaseScheduledChangeForSubscription({
            dbOrTx: db,
            stripe,
            stripeSubscriptionId: subscription.stripeSubscriptionId,
            stripeScheduleIdIfMissingRow: stripeScheduleId,
            kiloUserIdIfMissingRow: ctx.user.id,
            reason: 'schedule_change_creation_failed',
          });
        }

        // If we inserted a row (should be impossible due to ordering) we would want to mark it failed.
        // Keep error visibility by rethrowing.
        throw error;
      }
    }),

  cancelScheduledChange: baseProcedure
    .output(CancelScheduledChangeOutputSchema)
    .mutation(async ({ ctx }) => {
      const subscription = await getKiloPassStateForUser(db, ctx.user.id);
      if (!subscription) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'No Kilo Pass subscription found.' });
      }
      assertStripeManagedSubscription(subscription);

      const scheduledChange = await db.query.kilo_pass_scheduled_changes.findFirst({
        columns: { id: true, stripe_schedule_id: true },
        where: and(
          eq(kilo_pass_scheduled_changes.stripe_subscription_id, subscription.stripeSubscriptionId),
          isNull(kilo_pass_scheduled_changes.deleted_at)
        ),
      });

      if (!scheduledChange) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'No pending scheduled change found.',
        });
      }

      const scheduleId = scheduledChange.stripe_schedule_id;
      await releaseScheduledChangeForSubscription({
        dbOrTx: db,
        stripe,
        stripeSubscriptionId: subscription.stripeSubscriptionId,
        stripeScheduleIdIfMissingRow: scheduleId,
        kiloUserIdIfMissingRow: ctx.user.id,
        reason: 'cancel_scheduled_change',
      });

      return { success: true };
    }),

  getBillingHistory: baseProcedure
    .input(CursorInputSchema)
    .output(billingHistoryResponseSchema)
    .query(async ({ ctx, input }) => {
      const subscription = await getKiloPassStateForUser(db, ctx.user.id);
      if (!subscription) {
        return { entries: [], hasMore: false, cursor: null };
      }
      assertStripeManagedSubscription(subscription);

      const limit = input.limit ?? 10;
      const invoices = await stripe.invoices.list({
        subscription: subscription.stripeSubscriptionId,
        limit: limit + 1,
        starting_after: input.cursor ?? undefined,
      });

      const hasMore = invoices.data.length > limit;
      const page = hasMore ? invoices.data.slice(0, limit) : invoices.data;
      const entries = page.map(mapStripeInvoiceToBillingHistoryEntry);
      const lastInvoice = page[page.length - 1];
      const cursor = hasMore && lastInvoice ? lastInvoice.id : null;

      return { entries, hasMore, cursor };
    }),

  getCreditHistory: baseProcedure
    .input(CursorInputSchema)
    .output(KiloPassCreditHistoryResponseSchema)
    .query(async ({ ctx, input }) => {
      const subscription = await getKiloPassStateForUser(db, ctx.user.id);
      if (!subscription) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'No Kilo Pass subscription found.' });
      }

      const offset = parseOffsetCursor(input.cursor);
      const issuanceRows = await getKiloPassIssuanceCreditHistoryRows(subscription.subscriptionId);
      const storeUpgradeRows =
        subscription.paymentProvider === KiloPassPaymentProvider.Stripe
          ? []
          : await getStoreUpgradeCreditHistoryRows({
              kiloUserId: ctx.user.id,
              subscriptionId: subscription.subscriptionId,
              paymentProvider: subscription.paymentProvider,
            });
      const rows = [...issuanceRows, ...storeUpgradeRows].sort((a, b) => {
        const createdAtDiff = dayjs(b.createdAt).valueOf() - dayjs(a.createdAt).valueOf();
        if (createdAtDiff !== 0) return createdAtDiff;
        return b.id.localeCompare(a.id);
      });

      const pageRows = rows.slice(offset, offset + 26);
      const entries = pageRows.slice(0, 25).map(row => ({
        id: row.id,
        date: dayjs(row.createdAt).utc().toISOString(),
        amountUsd: row.amountUsd,
        kind: row.kind,
        description: row.description ?? `${row.kind} credits`,
      }));

      return {
        entries,
        hasMore: pageRows.length > 25,
        cursor: pageRows.length > 25 ? String(offset + 25) : null,
      };
    }),

  createCheckoutSession: baseProcedure
    .input(CreateCheckoutSessionInputSchema)
    .output(CreateCheckoutSessionOutputSchema)
    .mutation(async ({ input, ctx }) => {
      const { tier, cadence } = input;

      const existing = await getKiloPassStateForUser(db, ctx.user.id);
      if (existing && !isStripeSubscriptionEnded(existing.status)) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'You already have an active Kilo Pass subscription.',
        });
      }

      const stripeCustomerId = ctx.user.stripe_customer_id;
      if (!stripeCustomerId) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Missing Stripe customer for user.',
        });
      }

      const priceId = getStripePriceIdForKiloPass({ tier, cadence });
      const attribution = await getAffiliateAttribution(ctx.user.id, 'impact');
      const sessionMetadata = {
        type: 'kilo-pass',
        kiloUserId: ctx.user.id,
        tier,
        cadence,
        affiliateTrackingId: attribution?.tracking_id ?? '',
      };

      const session = await stripe.checkout.sessions.create({
        mode: 'subscription',
        customer: stripeCustomerId,
        allow_promotion_codes: true,
        billing_address_collection: 'required',
        line_items: [{ price: priceId, quantity: 1 }],
        customer_update: {
          name: 'auto',
          address: 'auto',
        },
        tax_id_collection: {
          enabled: true,
          required: 'never',
        },
        success_url: `${APP_URL}/payments/kilo-pass/awarding?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${APP_URL}/profile?kilo_pass_checkout=cancelled`,
        subscription_data: {
          metadata: sessionMetadata,
        },
        metadata: sessionMetadata,
      });

      return { url: typeof session.url === 'string' ? session.url : null };
    }),

  getChurnkeyAuthHash: baseProcedure
    .output(z.object({ hash: z.string(), customerId: z.string() }))
    .query(async ({ ctx }) => {
      const subscription = await getKiloPassStateForUser(db, ctx.user.id);
      if (subscription) {
        assertStripeManagedSubscription(subscription);
      }

      const stripeCustomerId = ctx.user.stripe_customer_id;
      if (!stripeCustomerId) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Missing Stripe customer for user.' });
      }

      return {
        hash: computeChurnkeyAuthHash(stripeCustomerId),
        customerId: stripeCustomerId,
      };
    }),
});
