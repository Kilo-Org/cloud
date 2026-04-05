import { KiloPassTier } from '@/lib/kilo-pass/enums';
import {
  computeMonthlyCadenceBonusPercent,
  computeYearlyCadenceMonthlyBonusUsd,
  getMonthlyPriceUsd,
} from './bonus';

import {
  KILO_PASS_FIRST_MONTH_PROMO_BONUS_PERCENT,
  KILO_PASS_MONTHLY_FIRST_2_MONTHS_PROMO_CUTOFF,
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
    it('applies the 50% promo for streak months 1 and 2 when eligible (strictly before cutoff)', () => {
      expect(
        computeMonthlyCadenceBonusPercent({
          tier: KiloPassTier.Tier19,
          streakMonths: 1,
          isFirstTimeSubscriberEver: true,
          subscriptionStartedAtIso: '2026-01-26T23:59:59.000Z',
        })
      ).toBeCloseTo(KILO_PASS_FIRST_MONTH_PROMO_BONUS_PERCENT);

      expect(
        computeMonthlyCadenceBonusPercent({
          tier: KiloPassTier.Tier19,
          streakMonths: 2,
          isFirstTimeSubscriberEver: true,
          subscriptionStartedAtIso: '2026-01-26T23:59:59.000Z',
        })
      ).toBeCloseTo(KILO_PASS_FIRST_MONTH_PROMO_BONUS_PERCENT);

      expect(
        computeMonthlyCadenceBonusPercent({
          tier: KiloPassTier.Tier19,
          streakMonths: 3,
          isFirstTimeSubscriberEver: true,
          subscriptionStartedAtIso: '2026-01-26T23:59:59.000Z',
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

  describe('computeMonthlyCadenceBonusPercent (promo cutoff behavior)', () => {
    const tier = KiloPassTier.Tier49;

    const computeFallback = (params: {
      streakMonths: number;
      isFirstTimeSubscriberEver: boolean;
    }): number => {
      return computeMonthlyCadenceBonusPercent({
        tier,
        streakMonths: params.streakMonths,
        isFirstTimeSubscriberEver: params.isFirstTimeSubscriberEver,
        subscriptionStartedAtIso: KILO_PASS_MONTHLY_FIRST_2_MONTHS_PROMO_CUTOFF.toISOString(),
      });
    };

    it('is ineligible at cutoff and returns the fallback value (month 1)', () => {
      expect(
        computeMonthlyCadenceBonusPercent({
          tier,
          streakMonths: 1,
          isFirstTimeSubscriberEver: true,
          subscriptionStartedAtIso: KILO_PASS_MONTHLY_FIRST_2_MONTHS_PROMO_CUTOFF.toISOString(),
        })
      ).toBe(computeFallback({ streakMonths: 1, isFirstTimeSubscriberEver: true }));
    });

    it('is ineligible at cutoff and returns the fallback value (month 2)', () => {
      expect(
        computeMonthlyCadenceBonusPercent({
          tier,
          streakMonths: 2,
          isFirstTimeSubscriberEver: true,
          subscriptionStartedAtIso: KILO_PASS_MONTHLY_FIRST_2_MONTHS_PROMO_CUTOFF.toISOString(),
        })
      ).toBe(computeFallback({ streakMonths: 2, isFirstTimeSubscriberEver: true }));
    });

    it('does not apply promo when isFirstTimeSubscriberEver is false', () => {
      expect(
        computeMonthlyCadenceBonusPercent({
          tier,
          streakMonths: 1,
          isFirstTimeSubscriberEver: false,
          subscriptionStartedAtIso: '2026-01-26T23:59:59.000Z',
        })
      ).toBe(computeFallback({ streakMonths: 1, isFirstTimeSubscriberEver: false }));
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
});
