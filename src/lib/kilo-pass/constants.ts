import { KiloPassTier } from '@/lib/kilo-pass/enums';
import { dayjs } from '@/lib/kilo-pass/dayjs';

type KiloPassTierConfig = {
  monthlyPriceUsd: number;
  monthlyBaseBonusPercent: number;
  monthlyStepBonusPercent: number;
  monthlyCapBonusPercent: number;
};

export const KILO_PASS_FIRST_MONTH_PROMO_BONUS_PERCENT = 0.5;

// First-time subscribers receive a 50% bonus for the first 2 months if they started
// strictly before this cutoff.
// The cutoff auto-advances to next Thursday at 11:59:59 PM PST (06:59:59 UTC).
// If today is Thursday, it targets the *following* Thursday so there's always ≥7 days.
// To end the promo, revert this to a fixed past date.
export function getKiloPassMonthlyFirst2MonthsPromoCutoff(now?: dayjs.Dayjs): dayjs.Dayjs {
  const today = (now ?? dayjs.utc()).startOf('day');
  const currentDow = today.day(); // 0=Sun … 4=Thu … 6=Sat
  const thursday = 4;
  let daysUntilThursday = (thursday - currentDow + 7) % 7;
  // If today IS Thursday, use next Thursday (7 days out) so there's always ≥7 days.
  if (daysUntilThursday === 0) daysUntilThursday = 7;
  return today.add(daysUntilThursday, 'day').hour(6).minute(59).second(59).millisecond(0);
}

export const KILO_PASS_MONTHLY_FIRST_2_MONTHS_PROMO_BONUS_PERCENT = 0.5;

export const KILO_PASS_YEARLY_MONTHLY_BONUS_PERCENT = 0.5;

export const KILO_PASS_MONTHLY_RAMP_BASE_BONUS_PERCENT = 0.05;
export const KILO_PASS_MONTHLY_RAMP_STEP_BONUS_PERCENT = 0.05;
export const KILO_PASS_MONTHLY_RAMP_CAP_BONUS_PERCENT = 0.4;

export const KILO_PASS_TIER_CONFIG = {
  [KiloPassTier.Tier19]: {
    monthlyPriceUsd: 19,
    monthlyBaseBonusPercent: KILO_PASS_MONTHLY_RAMP_BASE_BONUS_PERCENT,
    monthlyStepBonusPercent: KILO_PASS_MONTHLY_RAMP_STEP_BONUS_PERCENT,
    monthlyCapBonusPercent: KILO_PASS_MONTHLY_RAMP_CAP_BONUS_PERCENT,
  },
  [KiloPassTier.Tier49]: {
    monthlyPriceUsd: 49,
    monthlyBaseBonusPercent: KILO_PASS_MONTHLY_RAMP_BASE_BONUS_PERCENT,
    monthlyStepBonusPercent: KILO_PASS_MONTHLY_RAMP_STEP_BONUS_PERCENT,
    monthlyCapBonusPercent: KILO_PASS_MONTHLY_RAMP_CAP_BONUS_PERCENT,
  },
  [KiloPassTier.Tier199]: {
    monthlyPriceUsd: 199,
    monthlyBaseBonusPercent: KILO_PASS_MONTHLY_RAMP_BASE_BONUS_PERCENT,
    monthlyStepBonusPercent: KILO_PASS_MONTHLY_RAMP_STEP_BONUS_PERCENT,
    monthlyCapBonusPercent: KILO_PASS_MONTHLY_RAMP_CAP_BONUS_PERCENT,
  },
} satisfies Record<KiloPassTier, KiloPassTierConfig>;
