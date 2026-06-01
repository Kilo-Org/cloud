import { KiloPassCadence, type KiloPassTier } from '@/lib/kilo-pass/enums';
import {
  KILO_PASS_FIRST_MONTH_PROMO_BONUS_PERCENT,
  KILO_PASS_TIER_CONFIG,
  KILO_PASS_YEARLY_MONTHLY_BONUS_PERCENT,
} from '@/lib/kilo-pass/constants';

export const getMonthlyPriceUsd = (tier: KiloPassTier): number => {
  return KILO_PASS_TIER_CONFIG[tier].monthlyPriceUsd;
};

export const isKiloPassSelectionEligibleForKiloclawCommitUpsell = (params: {
  tier: KiloPassTier;
  cadence: KiloPassCadence;
  commitCostMicrodollars: number;
}): boolean => {
  if (params.cadence === KiloPassCadence.Yearly) {
    return true;
  }

  return getMonthlyPriceUsd(params.tier) * 1_000_000 >= params.commitCostMicrodollars;
};

export const computeMonthlyCadenceBonusPercent = (params: {
  tier: KiloPassTier;
  streakMonths: number;
  isFirstTimeSubscriberEver: boolean;
}): number => {
  const { tier, streakMonths, isFirstTimeSubscriberEver } = params;

  if (streakMonths < 1) {
    throw new Error('streakMonths must be >= 1');
  }

  if (streakMonths === 1 && isFirstTimeSubscriberEver) {
    return KILO_PASS_FIRST_MONTH_PROMO_BONUS_PERCENT;
  }

  const config = KILO_PASS_TIER_CONFIG[tier];
  const nMinus1 = streakMonths - 1;
  const uncapped = config.monthlyBaseBonusPercent + config.monthlyStepBonusPercent * nMinus1;

  return Math.min(config.monthlyCapBonusPercent, uncapped);
};

export const computeYearlyCadenceMonthlyBonusUsd = (tier: KiloPassTier): number => {
  return getMonthlyPriceUsd(tier) * KILO_PASS_YEARLY_MONTHLY_BONUS_PERCENT;
};
