import { dayjs } from '@/lib/kilo-pass/dayjs';
export {
  KILO_PASS_MONTHLY_RAMP_BASE_BONUS_PERCENT,
  KILO_PASS_MONTHLY_RAMP_CAP_BONUS_PERCENT,
  KILO_PASS_MONTHLY_RAMP_STEP_BONUS_PERCENT,
  KILO_PASS_TIER_CONFIG,
  KILO_PASS_YEARLY_MONTHLY_BONUS_PERCENT,
} from '@kilocode/worker-utils/kilo-pass-bonus-projection';

export const KILO_PASS_FIRST_MONTH_PROMO_BONUS_PERCENT = 0.5;

// First-time subscribers receive a 50% bonus for month 2 only if they started
// strictly before this grandfather cutoff. Month 1 remains 50% for new subscribers.
export const KILO_PASS_MONTHLY_FIRST_2_MONTHS_PROMO_CUTOFF = dayjs('2026-05-07T00:00:00Z').utc();

export const KILO_PASS_MONTHLY_FIRST_2_MONTHS_PROMO_BONUS_PERCENT = 0.5;
