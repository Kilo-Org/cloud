import { dayjs } from '@kilocode/web-shared/lib/kilo-pass/dayjs';
export {
  KILO_PASS_MONTHLY_RAMP_BASE_BONUS_PERCENT,
  KILO_PASS_MONTHLY_RAMP_CAP_BONUS_PERCENT,
  KILO_PASS_MONTHLY_RAMP_STEP_BONUS_PERCENT,
  KILO_PASS_TIER_CONFIG,
  KILO_PASS_YEARLY_MONTHLY_BONUS_PERCENT,
} from '@kilocode/worker-utils/kilo-pass-bonus-projection';

export const KILO_PASS_FIRST_MONTH_PROMO_BONUS_PERCENT = 0.5;

// Fixed historical boundary when the settled-payment fingerprint policy reached production.
// Changing this would retroactively change welcome-promo eligibility for existing issuances.
export const KILO_PASS_WELCOME_PROMO_FINGERPRINT_POLICY_ROLLOUT = dayjs(
  '2026-05-28T12:06:20.000Z'
).utc();

// Legacy first-time subscribers who started before this cutoff keep both promo months.
export const KILO_PASS_MONTHLY_FIRST_2_MONTHS_PROMO_CUTOFF = dayjs('2026-05-07T00:00:00Z').utc();

export const KILO_PASS_MONTHLY_FIRST_2_MONTHS_PROMO_BONUS_PERCENT = 0.5;
