import { KiloPassTier } from '@/lib/kilo-pass/enums';
import { dayjs } from '@/lib/kilo-pass/dayjs';

type KiloPassTierConfig = {
  monthlyPriceUsd: number;
  monthlyBaseBonusPercent: number;
  monthlyStepBonusPercent: number;
  monthlyCapBonusPercent: number;
};

export const KILO_PASS_FIRST_MONTH_PROMO_BONUS_PERCENT = 0.5;

// TODO: Remove KILO_PASS_MONTHLY_FIRST_2_MONTHS_PROMO_* constants and related logic after 2026-05-01 (cutoff + grace period).
// First-time subscribers receive a 50% bonus for the first 2 months if they started
// strictly before this cutoff.
export const KILO_PASS_MONTHLY_FIRST_2_MONTHS_PROMO_CUTOFF = dayjs('2026-02-14T07:59:59Z').utc();

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
