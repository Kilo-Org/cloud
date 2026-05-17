import {
  KiloPassCadence,
  type KiloPassTier,
  type StripeSubscriptionStatus,
} from '@kilocode/db/schema-types';

export type KiloPassBonusProjectionSubscription = {
  tier: KiloPassTier;
  cadence: KiloPassCadence;
  status: StripeSubscriptionStatus;
  currentStreakMonths: number;
};

export type KiloPassSubscriptionProjectionCandidate = {
  status: StripeSubscriptionStatus;
  cancelAtPeriodEnd: boolean;
  startedAt: string | null;
  createdAt: string;
};

export type KiloPassTierConfig = {
  monthlyPriceUsd: number;
  monthlyBaseBonusPercent: number;
  monthlyStepBonusPercent: number;
  monthlyCapBonusPercent: number;
};

export const KILO_PASS_YEARLY_MONTHLY_BONUS_PERCENT = 0.5;
export const KILO_PASS_MONTHLY_RAMP_BASE_BONUS_PERCENT = 0.05;
export const KILO_PASS_MONTHLY_RAMP_STEP_BONUS_PERCENT = 0.05;
export const KILO_PASS_MONTHLY_RAMP_CAP_BONUS_PERCENT = 0.4;

export const KILO_PASS_TIER_CONFIG = {
  tier_19: {
    monthlyPriceUsd: 19,
    monthlyBaseBonusPercent: KILO_PASS_MONTHLY_RAMP_BASE_BONUS_PERCENT,
    monthlyStepBonusPercent: KILO_PASS_MONTHLY_RAMP_STEP_BONUS_PERCENT,
    monthlyCapBonusPercent: KILO_PASS_MONTHLY_RAMP_CAP_BONUS_PERCENT,
  },
  tier_49: {
    monthlyPriceUsd: 49,
    monthlyBaseBonusPercent: KILO_PASS_MONTHLY_RAMP_BASE_BONUS_PERCENT,
    monthlyStepBonusPercent: KILO_PASS_MONTHLY_RAMP_STEP_BONUS_PERCENT,
    monthlyCapBonusPercent: KILO_PASS_MONTHLY_RAMP_CAP_BONUS_PERCENT,
  },
  tier_199: {
    monthlyPriceUsd: 199,
    monthlyBaseBonusPercent: KILO_PASS_MONTHLY_RAMP_BASE_BONUS_PERCENT,
    monthlyStepBonusPercent: KILO_PASS_MONTHLY_RAMP_STEP_BONUS_PERCENT,
    monthlyCapBonusPercent: KILO_PASS_MONTHLY_RAMP_CAP_BONUS_PERCENT,
  },
} satisfies Record<KiloPassTier, KiloPassTierConfig>;

export function getEffectiveKiloPassThreshold(
  kiloPassThresholdMicrodollars: number | null
): number | null {
  if (kiloPassThresholdMicrodollars === null) return null;
  return Math.max(0, kiloPassThresholdMicrodollars - 1_000_000);
}

export function computeProjectedKiloPassMonthlyCadenceBonusPercent(params: {
  tier: KiloPassTier;
  currentStreakMonths: number;
}): number {
  const streakMonths = Math.max(1, params.currentStreakMonths);
  const config = KILO_PASS_TIER_CONFIG[params.tier];
  const nMinus1 = streakMonths - 1;
  const uncapped = config.monthlyBaseBonusPercent + config.monthlyStepBonusPercent * nMinus1;

  return Math.min(config.monthlyCapBonusPercent, uncapped);
}

export function computeProjectedKiloPassBonusMicrodollars(params: {
  microdollarsUsed: number;
  kiloPassThreshold: number | null;
  subscription: KiloPassBonusProjectionSubscription | null;
}): number {
  const effectiveThreshold = getEffectiveKiloPassThreshold(params.kiloPassThreshold);
  if (effectiveThreshold === null || params.microdollarsUsed < effectiveThreshold) return 0;

  const subscription = params.subscription;
  if (!subscription || subscription.status !== 'active') return 0;

  const bonusPercent =
    subscription.cadence === KiloPassCadence.Monthly
      ? computeProjectedKiloPassMonthlyCadenceBonusPercent({
          tier: subscription.tier,
          currentStreakMonths: subscription.currentStreakMonths,
        })
      : KILO_PASS_YEARLY_MONTHLY_BONUS_PERCENT;

  return Math.round(
    KILO_PASS_TIER_CONFIG[subscription.tier].monthlyPriceUsd * bonusPercent * 1_000_000
  );
}

function getSubscriptionRecencyMillis(
  subscription: Pick<KiloPassSubscriptionProjectionCandidate, 'startedAt' | 'createdAt'>
): number {
  const startedAtMillis = subscription.startedAt ? Date.parse(subscription.startedAt) : NaN;
  if (Number.isFinite(startedAtMillis)) return startedAtMillis;

  const createdAtMillis = Date.parse(subscription.createdAt);
  return Number.isFinite(createdAtMillis) ? createdAtMillis : Number.NEGATIVE_INFINITY;
}

function getStatusPriority(row: KiloPassSubscriptionProjectionCandidate): number {
  if (row.status === 'active' && !row.cancelAtPeriodEnd) return 0;
  if (row.status === 'active' && row.cancelAtPeriodEnd) return 1;
  if (row.status === 'trialing') return 2;
  if (row.status === 'past_due') return 3;
  if (row.status === 'paused') return 4;
  if (row.status === 'incomplete') return 5;
  if (row.status === 'canceled' || row.status === 'incomplete_expired' || row.status === 'unpaid') {
    return 6;
  }
  return 7;
}

export function pickKiloPassSubscriptionForProjection<
  T extends KiloPassSubscriptionProjectionCandidate,
>(subscriptions: readonly T[]): T | null {
  if (subscriptions.length === 0) return null;

  const sorted = [...subscriptions].sort((a, b) => {
    const priorityDiff = getStatusPriority(a) - getStatusPriority(b);
    if (priorityDiff !== 0) return priorityDiff;
    return getSubscriptionRecencyMillis(b) - getSubscriptionRecencyMillis(a);
  });

  return sorted[0] ?? null;
}
