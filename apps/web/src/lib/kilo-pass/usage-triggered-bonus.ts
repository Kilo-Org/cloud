import 'server-only';

import {
  kilo_pass_issuance_items,
  kilo_pass_issuances,
  kilo_pass_subscriptions,
  kilocode_users,
} from '@kilocode/db/schema';
import { db as defaultDb } from '@/lib/drizzle';
import {
  KiloPassCadence,
  KiloPassIssuanceItemKind,
  KiloPassIssuanceSource,
} from '@/lib/kilo-pass/enums';
import {
  computeIssueMonth,
  createOrGetIssuanceHeader,
  issueBonusCreditsForIssuance,
} from '@/lib/kilo-pass/issuance';
import {
  KILO_PASS_TIER_CONFIG,
  KILO_PASS_YEARLY_MONTHLY_BONUS_PERCENT,
} from '@/lib/kilo-pass/constants';
import { computeMonthlyCadenceBonusPercent } from '@/lib/kilo-pass/bonus';
import { dayjs } from '@/lib/kilo-pass/dayjs';
import { getKiloPassStateForUser, type KiloPassSubscriptionState } from '@/lib/kilo-pass/state';
import { getEffectiveKiloPassThreshold } from '@/lib/kilo-pass/threshold';
import { and, desc, eq, inArray, ne } from 'drizzle-orm';

type Db = typeof defaultDb;
type Tx = Parameters<Db['transaction']>[0] extends (tx: infer T) => unknown ? T : never;

export type UsageTriggeredMonthlyBonusDecision = {
  bonusPercentApplied: number;
  shouldIssueFirstMonthPromo: boolean;
  description: string;
  auditPayload: Record<string, unknown>;
};

export function computeUsageTriggeredMonthlyBonusDecision(params: {
  tier: KiloPassSubscriptionState['tier'];
  startedAtIso: string | null;
  currentStreakMonths: number;
  isFirstTimeSubscriberEver: boolean;
  issueMonth: string;
}): UsageTriggeredMonthlyBonusDecision {
  const streakMonths = Math.max(1, params.currentStreakMonths);
  const bonusPercentApplied = computeMonthlyCadenceBonusPercent({
    tier: params.tier,
    streakMonths,
    isFirstTimeSubscriberEver: params.isFirstTimeSubscriberEver,
    subscriptionStartedAtIso: params.startedAtIso,
  });

  const shouldIssueFirstMonthPromo = bonusPercentApplied === 0.5 && streakMonths <= 2;

  const decisionWithContext = {
    monthlyBonusDecision: {
      streakMonths,
      startedAt: params.startedAtIso,
      issueMonth: params.issueMonth,
      bonusPercentApplied,
    },
  } satisfies Record<string, unknown>;

  return {
    bonusPercentApplied,
    shouldIssueFirstMonthPromo,
    description: shouldIssueFirstMonthPromo
      ? `Kilo Pass promo 50% bonus (${params.tier}, streak=${streakMonths})`
      : `Kilo Pass monthly bonus (${params.tier}, streak=${streakMonths})`,
    auditPayload: {
      ...decisionWithContext,
      bonusKind: shouldIssueFirstMonthPromo ? 'promo-50pct' : 'monthly-ramp',
    },
  };
}

export function computeUsageTriggeredYearlyIssueMonth(params: {
  nextYearlyIssueAtIso: string | null;
  startedAtIso: string | null;
}): { currentPeriodStartIso: string | null; issueMonth: string | null } {
  const currentPeriodStartIso =
    params.nextYearlyIssueAtIso != null
      ? dayjs(params.nextYearlyIssueAtIso).utc().subtract(1, 'month').toISOString()
      : params.startedAtIso;

  if (currentPeriodStartIso == null) {
    return { currentPeriodStartIso: null, issueMonth: null };
  }

  const issueMonth = computeIssueMonth(dayjs(currentPeriodStartIso).utc());
  return { currentPeriodStartIso, issueMonth };
}

async function clearKiloPassThreshold(tx: Tx, params: { kiloUserId: string }): Promise<void> {
  await tx
    .update(kilocode_users)
    .set({ kilo_pass_threshold: null })
    .where(eq(kilocode_users.id, params.kiloUserId));
}

async function issueBonusCredits(params: {
  tx: Tx;
  issuanceId: string;
  subscriptionId: string;
  kiloUserId: string;
  baseAmountUsd: number;
  bonusPercentApplied: number;
  stripeInvoiceId: string | null;
  description: string;
  auditPayload?: Record<string, unknown>;
}): Promise<{ wasIssued: boolean }> {
  const bonusResult = await issueBonusCreditsForIssuance(params.tx, {
    issuanceId: params.issuanceId,
    subscriptionId: params.subscriptionId,
    kiloUserId: params.kiloUserId,
    baseAmountUsd: params.baseAmountUsd,
    bonusPercentApplied: params.bonusPercentApplied,
    stripeInvoiceId: params.stripeInvoiceId,
    description: params.description,
    auditPayload: params.auditPayload,
  });

  return { wasIssued: bonusResult.wasIssued };
}

type UsageTriggeredBonusDecision = {
  bonusPercentApplied: number;
  description: string;
  auditPayload?: Record<string, unknown>;
};

async function getLatestIssuanceForMonthlyCadence(
  tx: Tx,
  params: { subscriptionId: string }
): Promise<{ issuanceId: string; issueMonth: string; stripeInvoiceId: string | null } | null> {
  const issuanceRows = await tx
    .select({
      issuanceId: kilo_pass_issuances.id,
      issueMonth: kilo_pass_issuances.issue_month,
      stripeInvoiceId: kilo_pass_issuances.stripe_invoice_id,
    })
    .from(kilo_pass_issuances)
    .where(eq(kilo_pass_issuances.kilo_pass_subscription_id, params.subscriptionId))
    .orderBy(desc(kilo_pass_issuances.issue_month))
    .limit(1);

  const latestIssuance = issuanceRows[0];
  if (!latestIssuance) return null;

  return {
    issuanceId: latestIssuance.issuanceId,
    issueMonth: latestIssuance.issueMonth,
    stripeInvoiceId: latestIssuance.stripeInvoiceId,
  };
}

async function getOrCreateIssuanceForYearlyCadence(
  tx: Tx,
  params: {
    subscriptionId: string;
    nextYearlyIssueAtIso: string | null;
    startedAtIso: string | null;
  }
): Promise<{ issuanceId: string; issueMonth: string; stripeInvoiceId: string | null } | null> {
  const { issueMonth } = computeUsageTriggeredYearlyIssueMonth({
    nextYearlyIssueAtIso: params.nextYearlyIssueAtIso,
    startedAtIso: params.startedAtIso,
  });

  if (issueMonth == null) return null;

  const issuanceHeader = await createOrGetIssuanceHeader(tx, {
    subscriptionId: params.subscriptionId,
    issueMonth,
    source: KiloPassIssuanceSource.Cron,
    stripeInvoiceId: null,
  });

  const issuanceRow = await tx.query.kilo_pass_issuances.findFirst({
    columns: { stripe_invoice_id: true },
    where: eq(kilo_pass_issuances.id, issuanceHeader.issuanceId),
  });

  return {
    issuanceId: issuanceHeader.issuanceId,
    issueMonth,
    stripeInvoiceId: issuanceRow?.stripe_invoice_id ?? null,
  };
}

async function maybeIssueBonusFromUsageThreshold(
  tx: Tx,
  params: {
    subscription: KiloPassSubscriptionState;
    kiloUserId: string;
    monthlyBaseAmountUsd: number;
  }
): Promise<void> {
  const { subscription, kiloUserId, monthlyBaseAmountUsd } = params;

  const issuance =
    subscription.cadence === KiloPassCadence.Monthly
      ? await getLatestIssuanceForMonthlyCadence(tx, {
          subscriptionId: subscription.subscriptionId,
        })
      : await getOrCreateIssuanceForYearlyCadence(tx, {
          subscriptionId: subscription.subscriptionId,
          nextYearlyIssueAtIso: subscription.nextYearlyIssueAt,
          startedAtIso: subscription.startedAt,
        });

  if (!issuance) {
    await clearKiloPassThreshold(tx, { kiloUserId });
    return;
  }

  const baseItem = await tx.query.kilo_pass_issuance_items.findFirst({
    columns: { id: true },
    where: and(
      eq(kilo_pass_issuance_items.kilo_pass_issuance_id, issuance.issuanceId),
      eq(kilo_pass_issuance_items.kind, KiloPassIssuanceItemKind.Base)
    ),
  });
  if (!baseItem) {
    await clearKiloPassThreshold(tx, { kiloUserId });
    return;
  }

  const alreadyIssuedItem = await tx.query.kilo_pass_issuance_items.findFirst({
    columns: { id: true },
    where: and(
      eq(kilo_pass_issuance_items.kilo_pass_issuance_id, issuance.issuanceId),
      inArray(kilo_pass_issuance_items.kind, [
        KiloPassIssuanceItemKind.Bonus,
        KiloPassIssuanceItemKind.PromoFirstMonth50Pct,
      ])
    ),
  });
  if (alreadyIssuedItem) {
    await clearKiloPassThreshold(tx, { kiloUserId });
    return;
  }

  const decision: UsageTriggeredBonusDecision = await (async () => {
    if (subscription.cadence !== KiloPassCadence.Monthly) {
      return {
        bonusPercentApplied: KILO_PASS_YEARLY_MONTHLY_BONUS_PERCENT,
        description: `Kilo Pass yearly monthly bonus (${subscription.tier}, ${issuance.issueMonth})`,
      };
    }

    const otherSubscription = await tx
      .select({ id: kilo_pass_subscriptions.id })
      .from(kilo_pass_subscriptions)
      .where(
        and(
          eq(kilo_pass_subscriptions.kilo_user_id, kiloUserId),
          ne(kilo_pass_subscriptions.id, subscription.subscriptionId)
        )
      )
      .limit(1);

    const isFirstTimeSubscriberEver = otherSubscription.length === 0;
    const monthlyDecision = computeUsageTriggeredMonthlyBonusDecision({
      tier: subscription.tier,
      startedAtIso: subscription.startedAt,
      currentStreakMonths: subscription.currentStreakMonths,
      isFirstTimeSubscriberEver,
      issueMonth: issuance.issueMonth,
    });

    return {
      bonusPercentApplied: monthlyDecision.bonusPercentApplied,
      description: monthlyDecision.description,
      auditPayload: monthlyDecision.auditPayload,
    };
  })();

  await issueBonusCredits({
    tx,
    issuanceId: issuance.issuanceId,
    subscriptionId: subscription.subscriptionId,
    kiloUserId,
    baseAmountUsd: monthlyBaseAmountUsd,
    bonusPercentApplied: decision.bonusPercentApplied,
    stripeInvoiceId: issuance.stripeInvoiceId,
    description: decision.description,
    auditPayload: decision.auditPayload,
  });

  await clearKiloPassThreshold(tx, { kiloUserId });
}

export async function maybeIssueKiloPassBonusFromUsageThreshold(params: {
  kiloUserId: string;
  nowIso: string;
  db?: Db;
}): Promise<void> {
  const { kiloUserId } = params;
  const db = params.db ?? defaultDb;

  await db.transaction(async tx => {
    const userRows = await tx
      .select({
        microdollarsUsed: kilocode_users.microdollars_used,
        kiloPassThreshold: kilocode_users.kilo_pass_threshold,
      })
      .from(kilocode_users)
      .where(eq(kilocode_users.id, kiloUserId))
      .for('update')
      .limit(1);

    const user = userRows[0];
    if (!user) return;

    const kiloPassThreshold = user.kiloPassThreshold;
    const effectiveThreshold = getEffectiveKiloPassThreshold(kiloPassThreshold);
    if (effectiveThreshold === null || user.microdollarsUsed < effectiveThreshold) return;

    const subscriptionState = await getKiloPassStateForUser(tx, kiloUserId);
    if (!subscriptionState || subscriptionState.status !== 'active') {
      await clearKiloPassThreshold(tx, { kiloUserId });
      return;
    }

    const tierConfig = KILO_PASS_TIER_CONFIG[subscriptionState.tier];
    const monthlyBaseAmountUsd = tierConfig.monthlyPriceUsd;

    await maybeIssueBonusFromUsageThreshold(tx, {
      subscription: subscriptionState,
      kiloUserId,
      monthlyBaseAmountUsd,
    });
  });
}
