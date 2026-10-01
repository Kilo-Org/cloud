import {
  KiloPassCadence,
  type KiloPassTier,
  KiloPassWelcomePromoEligibilityReason,
} from '@/lib/kilo-pass/enums';
import type { KiloPassWelcomePromoPolicy } from '@/lib/kilo-pass/welcome-promo-context';
import {
  computeMonthlyCadenceBonusPercent,
  computeYearlyCadenceMonthlyBonusUsd,
  getMonthlyPriceUsd,
} from '@/lib/kilo-pass/bonus';

export type KiloPassMonthlyBonusKind = 'promo-50pct' | 'monthly-ramp';

export type KiloPassMonthlyBonusDecision = {
  bonusPercentApplied: number;
  bonusUsd: number;
  bonusKind: KiloPassMonthlyBonusKind;
  shouldIssueFirstMonthPromo: boolean;
  description: string;
  auditPayload: Record<string, unknown>;
};

export function computeKiloPassBonusUsd(params: {
  baseAmountUsd: number;
  bonusPercentApplied: number;
}): number {
  const baseCents = Math.round(params.baseAmountUsd * 100);
  const bonusCents = Math.round(baseCents * params.bonusPercentApplied);
  return bonusCents / 100;
}

function isAllowedStripeWelcomePromoReason(
  reason: KiloPassWelcomePromoEligibilityReason | null | undefined
): boolean {
  return (
    reason === KiloPassWelcomePromoEligibilityReason.FirstPaymentFingerprintClaim ||
    reason === KiloPassWelcomePromoEligibilityReason.MissingFingerprint ||
    reason === KiloPassWelcomePromoEligibilityReason.NoSupportedFingerprint
  );
}

export function computeMonthlyKiloPassBonusDecision(params: {
  tier: KiloPassTier;
  startedAtIso: string | null;
  streakMonths: number;
  isFirstTimeSubscriberEver: boolean;
  welcomePromoPolicy: KiloPassWelcomePromoPolicy;
  welcomePromoEligibilityReason?: KiloPassWelcomePromoEligibilityReason | null;
  issueMonth?: string;
}): KiloPassMonthlyBonusDecision {
  const streakMonths = Math.max(1, params.streakMonths);
  const hasRequiredPaymentEligibility =
    params.welcomePromoPolicy === 'account-history-only' ||
    isAllowedStripeWelcomePromoReason(params.welcomePromoEligibilityReason);
  const isEligibleForWelcomePromo =
    params.isFirstTimeSubscriberEver && hasRequiredPaymentEligibility;
  const bonusPercentApplied = computeMonthlyCadenceBonusPercent({
    tier: params.tier,
    streakMonths,
    isFirstTimeSubscriberEver: isEligibleForWelcomePromo,
    subscriptionStartedAtIso: params.startedAtIso,
  });
  const shouldIssueFirstMonthPromo = bonusPercentApplied === 0.5 && streakMonths <= 2;
  const bonusKind: KiloPassMonthlyBonusKind = shouldIssueFirstMonthPromo
    ? 'promo-50pct'
    : 'monthly-ramp';

  return {
    bonusPercentApplied,
    bonusUsd: computeKiloPassBonusUsd({
      baseAmountUsd: getMonthlyPriceUsd(params.tier),
      bonusPercentApplied,
    }),
    bonusKind,
    shouldIssueFirstMonthPromo,
    description: shouldIssueFirstMonthPromo
      ? `Kilo Pass promo 50% bonus (${params.tier}, streak=${streakMonths})`
      : `Kilo Pass monthly bonus (${params.tier}, streak=${streakMonths})`,
    auditPayload: {
      monthlyBonusDecision: {
        streakMonths,
        startedAt: params.startedAtIso,
        issueMonth: params.issueMonth ?? null,
        bonusPercentApplied,
        welcomePromoPolicy: params.welcomePromoPolicy,
        welcomePromoEligibilityReason: params.welcomePromoEligibilityReason ?? null,
      },
      bonusKind,
    },
  };
}

export function computeKiloPassBonusCreditsUsd(params: {
  tier: KiloPassTier;
  cadence: KiloPassCadence;
  startedAtIso: string | null;
  streakMonths: number;
  isFirstTimeSubscriberEver: boolean;
  welcomePromoPolicy: KiloPassWelcomePromoPolicy;
  welcomePromoEligibilityReason?: KiloPassWelcomePromoEligibilityReason | null;
}): number {
  if (params.cadence === KiloPassCadence.Yearly) {
    return computeKiloPassBonusUsd({
      baseAmountUsd: getMonthlyPriceUsd(params.tier),
      bonusPercentApplied:
        computeYearlyCadenceMonthlyBonusUsd(params.tier) / getMonthlyPriceUsd(params.tier),
    });
  }

  return computeMonthlyKiloPassBonusDecision({
    tier: params.tier,
    startedAtIso: params.startedAtIso,
    streakMonths: params.streakMonths,
    isFirstTimeSubscriberEver: params.isFirstTimeSubscriberEver,
    welcomePromoPolicy: params.welcomePromoPolicy,
    welcomePromoEligibilityReason: params.welcomePromoEligibilityReason,
  }).bonusUsd;
}
