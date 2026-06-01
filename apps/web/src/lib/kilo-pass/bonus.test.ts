import { KiloPassCadence, KiloPassTier } from '@/lib/kilo-pass/enums';
import {
  computeMonthlyCadenceBonusPercent,
  computeYearlyCadenceMonthlyBonusUsd,
  getMonthlyPriceUsd,
  isKiloPassSelectionEligibleForKiloclawCommitUpsell,
} from './bonus';

import {
  KILO_PASS_FIRST_MONTH_PROMO_BONUS_PERCENT,
  KILO_PASS_MONTHLY_RAMP_BASE_BONUS_PERCENT,
  KILO_PASS_MONTHLY_RAMP_CAP_BONUS_PERCENT,
  KILO_PASS_MONTHLY_RAMP_STEP_BONUS_PERCENT,
  KILO_PASS_TIER_CONFIG,
  KILO_PASS_YEARLY_MONTHLY_BONUS_PERCENT,
} from './constants';

describe('kilo pass bonus utilities', () => {
  describe('getMonthlyPriceUsd', () => {
    it('returns the correct monthly prices', () => {
      expect(getMonthlyPriceUsd(KiloPassTier.Tier19)).toBe(
        KILO_PASS_TIER_CONFIG.tier_19.monthlyPriceUsd
      );
      expect(getMonthlyPriceUsd(KiloPassTier.Tier49)).toBe(
        KILO_PASS_TIER_CONFIG.tier_49.monthlyPriceUsd
      );
      expect(getMonthlyPriceUsd(KiloPassTier.Tier199)).toBe(
        KILO_PASS_TIER_CONFIG.tier_199.monthlyPriceUsd
      );
    });
  });

  describe('monthly ramp (non-promo)', () => {
    it('computes ramp for tier_19 (base 5%, step 5%, cap 40%)', () => {
      const config = KILO_PASS_TIER_CONFIG.tier_19;
      expect(
        computeMonthlyCadenceBonusPercent({
          tier: KiloPassTier.Tier19,
          streakMonths: 1,
          isFirstTimeSubscriberEver: false,
        })
      ).toBeCloseTo(config.monthlyBaseBonusPercent + config.monthlyStepBonusPercent * 0);
      expect(
        computeMonthlyCadenceBonusPercent({
          tier: KiloPassTier.Tier19,
          streakMonths: 2,
          isFirstTimeSubscriberEver: false,
        })
      ).toBeCloseTo(config.monthlyBaseBonusPercent + config.monthlyStepBonusPercent * 1);
      expect(
        computeMonthlyCadenceBonusPercent({
          tier: KiloPassTier.Tier19,
          streakMonths: 3,
          isFirstTimeSubscriberEver: false,
        })
      ).toBeCloseTo(config.monthlyBaseBonusPercent + config.monthlyStepBonusPercent * 2);
    });

    it('computes ramp for tier_49 (base 5%, step 5%, cap 40%)', () => {
      const config = KILO_PASS_TIER_CONFIG.tier_49;
      expect(
        computeMonthlyCadenceBonusPercent({
          tier: KiloPassTier.Tier49,
          streakMonths: 1,
          isFirstTimeSubscriberEver: false,
        })
      ).toBeCloseTo(config.monthlyBaseBonusPercent + config.monthlyStepBonusPercent * 0);
      expect(
        computeMonthlyCadenceBonusPercent({
          tier: KiloPassTier.Tier49,
          streakMonths: 2,
          isFirstTimeSubscriberEver: false,
        })
      ).toBeCloseTo(config.monthlyBaseBonusPercent + config.monthlyStepBonusPercent * 1);
      expect(
        computeMonthlyCadenceBonusPercent({
          tier: KiloPassTier.Tier49,
          streakMonths: 3,
          isFirstTimeSubscriberEver: false,
        })
      ).toBeCloseTo(config.monthlyBaseBonusPercent + config.monthlyStepBonusPercent * 2);
    });

    it('computes ramp for tier_199 (base 5%, step 5%, cap 40%)', () => {
      const config = KILO_PASS_TIER_CONFIG.tier_199;
      expect(
        computeMonthlyCadenceBonusPercent({
          tier: KiloPassTier.Tier199,
          streakMonths: 1,
          isFirstTimeSubscriberEver: false,
        })
      ).toBeCloseTo(config.monthlyBaseBonusPercent + config.monthlyStepBonusPercent * 0);
      expect(
        computeMonthlyCadenceBonusPercent({
          tier: KiloPassTier.Tier199,
          streakMonths: 2,
          isFirstTimeSubscriberEver: false,
        })
      ).toBeCloseTo(config.monthlyBaseBonusPercent + config.monthlyStepBonusPercent * 1);
      expect(
        computeMonthlyCadenceBonusPercent({
          tier: KiloPassTier.Tier199,
          streakMonths: 3,
          isFirstTimeSubscriberEver: false,
        })
      ).toBeCloseTo(config.monthlyBaseBonusPercent + config.monthlyStepBonusPercent * 2);
    });

    it('caps at 0.40 for all tiers', () => {
      expect(
        computeMonthlyCadenceBonusPercent({
          tier: KiloPassTier.Tier19,
          streakMonths: 100,
          isFirstTimeSubscriberEver: false,
        })
      ).toBeCloseTo(KILO_PASS_TIER_CONFIG.tier_19.monthlyCapBonusPercent);
      expect(
        computeMonthlyCadenceBonusPercent({
          tier: KiloPassTier.Tier49,
          streakMonths: 100,
          isFirstTimeSubscriberEver: false,
        })
      ).toBeCloseTo(KILO_PASS_TIER_CONFIG.tier_49.monthlyCapBonusPercent);
      expect(
        computeMonthlyCadenceBonusPercent({
          tier: KiloPassTier.Tier199,
          streakMonths: 100,
          isFirstTimeSubscriberEver: false,
        })
      ).toBeCloseTo(KILO_PASS_TIER_CONFIG.tier_199.monthlyCapBonusPercent);
    });

    it('uses the unified base/step/cap constants for all tiers', () => {
      expect(KILO_PASS_TIER_CONFIG.tier_19.monthlyBaseBonusPercent).toBe(
        KILO_PASS_MONTHLY_RAMP_BASE_BONUS_PERCENT
      );
      expect(KILO_PASS_TIER_CONFIG.tier_49.monthlyBaseBonusPercent).toBe(
        KILO_PASS_MONTHLY_RAMP_BASE_BONUS_PERCENT
      );
      expect(KILO_PASS_TIER_CONFIG.tier_199.monthlyBaseBonusPercent).toBe(
        KILO_PASS_MONTHLY_RAMP_BASE_BONUS_PERCENT
      );

      expect(KILO_PASS_TIER_CONFIG.tier_19.monthlyStepBonusPercent).toBe(
        KILO_PASS_MONTHLY_RAMP_STEP_BONUS_PERCENT
      );
      expect(KILO_PASS_TIER_CONFIG.tier_49.monthlyStepBonusPercent).toBe(
        KILO_PASS_MONTHLY_RAMP_STEP_BONUS_PERCENT
      );
      expect(KILO_PASS_TIER_CONFIG.tier_199.monthlyStepBonusPercent).toBe(
        KILO_PASS_MONTHLY_RAMP_STEP_BONUS_PERCENT
      );

      expect(KILO_PASS_TIER_CONFIG.tier_19.monthlyCapBonusPercent).toBe(
        KILO_PASS_MONTHLY_RAMP_CAP_BONUS_PERCENT
      );
      expect(KILO_PASS_TIER_CONFIG.tier_49.monthlyCapBonusPercent).toBe(
        KILO_PASS_MONTHLY_RAMP_CAP_BONUS_PERCENT
      );
      expect(KILO_PASS_TIER_CONFIG.tier_199.monthlyCapBonusPercent).toBe(
        KILO_PASS_MONTHLY_RAMP_CAP_BONUS_PERCENT
      );
    });
  });

  describe('computeMonthlyCadenceBonusPercent', () => {
    it('applies the 50% promo for streak month 1 when first-time subscriber', () => {
      expect(
        computeMonthlyCadenceBonusPercent({
          tier: KiloPassTier.Tier19,
          streakMonths: 1,
          isFirstTimeSubscriberEver: true,
        })
      ).toBeCloseTo(KILO_PASS_FIRST_MONTH_PROMO_BONUS_PERCENT);
    });

    it('uses the standard ramp for streak month 2 even for first-time subscribers', () => {
      expect(
        computeMonthlyCadenceBonusPercent({
          tier: KiloPassTier.Tier19,
          streakMonths: 2,
          isFirstTimeSubscriberEver: true,
        })
      ).toBeCloseTo(
        KILO_PASS_TIER_CONFIG.tier_19.monthlyBaseBonusPercent +
          KILO_PASS_TIER_CONFIG.tier_19.monthlyStepBonusPercent * 1
      );
    });

    it('uses the standard ramp for streak month 3 for first-time subscribers', () => {
      expect(
        computeMonthlyCadenceBonusPercent({
          tier: KiloPassTier.Tier19,
          streakMonths: 3,
          isFirstTimeSubscriberEver: true,
        })
      ).toBeCloseTo(
        KILO_PASS_TIER_CONFIG.tier_19.monthlyBaseBonusPercent +
          KILO_PASS_TIER_CONFIG.tier_19.monthlyStepBonusPercent * 2
      );
    });

    it('does not apply the override when isFirstTimeSubscriberEver is false', () => {
      expect(
        computeMonthlyCadenceBonusPercent({
          tier: KiloPassTier.Tier49,
          streakMonths: 1,
          isFirstTimeSubscriberEver: false,
        })
      ).toBeCloseTo(KILO_PASS_TIER_CONFIG.tier_49.monthlyBaseBonusPercent);
    });
  });

  describe('computeYearlyCadenceMonthlyBonusUsd', () => {
    it('returns half of monthly price as monthly bonus USD', () => {
      expect(computeYearlyCadenceMonthlyBonusUsd(KiloPassTier.Tier19)).toBe(
        KILO_PASS_TIER_CONFIG.tier_19.monthlyPriceUsd * KILO_PASS_YEARLY_MONTHLY_BONUS_PERCENT
      );
      expect(computeYearlyCadenceMonthlyBonusUsd(KiloPassTier.Tier49)).toBe(
        KILO_PASS_TIER_CONFIG.tier_49.monthlyPriceUsd * KILO_PASS_YEARLY_MONTHLY_BONUS_PERCENT
      );
      expect(computeYearlyCadenceMonthlyBonusUsd(KiloPassTier.Tier199)).toBe(
        KILO_PASS_TIER_CONFIG.tier_199.monthlyPriceUsd * KILO_PASS_YEARLY_MONTHLY_BONUS_PERCENT
      );
    });
  });

  describe('isKiloPassSelectionEligibleForKiloclawCommitUpsell', () => {
    const commitCostMicrodollars = 48_000_000;

    it('rejects monthly tiers whose configured price is below the commit threshold', () => {
      expect(
        isKiloPassSelectionEligibleForKiloclawCommitUpsell({
          tier: KiloPassTier.Tier19,
          cadence: KiloPassCadence.Monthly,
          commitCostMicrodollars,
        })
      ).toBe(false);
    });

    it('allows monthly tiers whose configured price covers the commit threshold', () => {
      expect(
        isKiloPassSelectionEligibleForKiloclawCommitUpsell({
          tier: KiloPassTier.Tier49,
          cadence: KiloPassCadence.Monthly,
          commitCostMicrodollars,
        })
      ).toBe(true);
    });

    it('keeps annual tiers eligible under current upsell policy', () => {
      expect(
        isKiloPassSelectionEligibleForKiloclawCommitUpsell({
          tier: KiloPassTier.Tier19,
          cadence: KiloPassCadence.Yearly,
          commitCostMicrodollars,
        })
      ).toBe(true);
    });
  });
});
