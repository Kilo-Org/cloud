import type { KiloPassTier } from '@/lib/kilo-pass/enums';
import {
  KILO_PASS_FIRST_MONTH_PROMO_BONUS_PERCENT,
  KILO_PASS_MONTHLY_FIRST_2_MONTHS_PROMO_BONUS_PERCENT,
  KILO_PASS_MONTHLY_FIRST_2_MONTHS_PROMO_CUTOFF,
  KILO_PASS_TIER_CONFIG,
  KILO_PASS_YEARLY_MONTHLY_BONUS_PERCENT,
} from '@/lib/kilo-pass/constants';
import { dayjs } from '@/lib/kilo-pass/dayjs';

export const getMonthlyPriceUsd = (tier: KiloPassTier): number => {
  return KILO_PASS_TIER_CONFIG[tier].monthlyPriceUsd;
};

export const computeMonthlyCadenceBonusPercent = (params: {
  tier: KiloPassTier;
  streakMonths: number;
  isFirstTimeSubscriberEver: boolean;
  subscriptionStartedAtIso?: string | null;
}): number => {
  const { tier, streakMonths, isFirstTimeSubscriberEver, subscriptionStartedAtIso } = params;

  if (streakMonths < 1) {
    throw new Error('streakMonths must be >= 1');
  }

  // Limited-time promo: first-time subscribers who started strictly before the cutoff
  // get a 50% bonus for streak months 1 and 2.
  if (streakMonths <= 2 && isFirstTimeSubscriberEver) {
    const startedAt = subscriptionStartedAtIso ?? null;
    if (startedAt != null) {
      const startedAtUtc = dayjs(startedAt).utc();

      if (
        startedAtUtc.isValid() &&
        startedAtUtc.isBefore(KILO_PASS_MONTHLY_FIRST_2_MONTHS_PROMO_CUTOFF)
      ) {
        return KILO_PASS_MONTHLY_FIRST_2_MONTHS_PROMO_BONUS_PERCENT;
      }
    }

    // Back-compat: if we don't have a start timestamp, still show the first month promo.
    if (streakMonths === 1) {
      return KILO_PASS_FIRST_MONTH_PROMO_BONUS_PERCENT;
    }
  }

  const config = KILO_PASS_TIER_CONFIG[tier];
  const nMinus1 = streakMonths - 1;
  const uncapped = config.monthlyBaseBonusPercent + config.monthlyStepBonusPercent * nMinus1;

  return Math.min(config.monthlyCapBonusPercent, uncapped);
};

export const computeYearlyCadenceMonthlyBonusUsd = (tier: KiloPassTier): number => {
  return getMonthlyPriceUsd(tier) * KILO_PASS_YEARLY_MONTHLY_BONUS_PERCENT;
};
