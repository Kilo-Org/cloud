import { KiloPassTier } from '@/lib/kilo-pass/enums';
import {
  computeMonthlyCadenceBonusPercent,
  computeYearlyCadenceMonthlyBonusUsd,
  getMonthlyPriceUsd,
} from './bonus';

import {
  KILO_PASS_FIRST_MONTH_PROMO_BONUS_PERCENT,
  getKiloPassMonthlyFirst2MonthsPromoCutoff,
  KILO_PASS_MONTHLY_RAMP_BASE_BONUS_PERCENT,
  KILO_PASS_MONTHLY_RAMP_CAP_BONUS_PERCENT,
  KILO_PASS_MONTHLY_RAMP_STEP_BONUS_PERCENT,
  KILO_PASS_TIER_CONFIG,
  KILO_PASS_YEARLY_MONTHLY_BONUS_PERCENT,
} from './constants';
import { dayjs } from './dayjs';

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
        subscriptionStartedAtIso: getKiloPassMonthlyFirst2MonthsPromoCutoff().toISOString(),
      });
    };

    it('is ineligible at cutoff and returns the fallback value (month 1)', () => {
      expect(
        computeMonthlyCadenceBonusPercent({
          tier,
          streakMonths: 1,
          isFirstTimeSubscriberEver: true,
          subscriptionStartedAtIso: getKiloPassMonthlyFirst2MonthsPromoCutoff().toISOString(),
        })
      ).toBe(computeFallback({ streakMonths: 1, isFirstTimeSubscriberEver: true }));
    });

    it('is ineligible at cutoff and returns the fallback value (month 2)', () => {
      expect(
        computeMonthlyCadenceBonusPercent({
          tier,
          streakMonths: 2,
          isFirstTimeSubscriberEver: true,
          subscriptionStartedAtIso: getKiloPassMonthlyFirst2MonthsPromoCutoff().toISOString(),
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

  describe('getKiloPassMonthlyFirst2MonthsPromoCutoff', () => {
    it('returns the next Thursday when today is Monday', () => {
      // 2026-03-23 is a Monday
      const monday = dayjs.utc('2026-03-23T12:00:00Z');
      const cutoff = getKiloPassMonthlyFirst2MonthsPromoCutoff(monday);
      expect(cutoff.day()).toBe(4); // Thursday
      expect(cutoff.format('YYYY-MM-DD')).toBe('2026-03-26');
      expect(cutoff.hour()).toBe(6);
      expect(cutoff.minute()).toBe(59);
      expect(cutoff.second()).toBe(59);
    });

    it('returns next Thursday (7 days out) when today is Thursday', () => {
      // 2026-03-26 is a Thursday
      const thursday = dayjs.utc('2026-03-26T12:00:00Z');
      const cutoff = getKiloPassMonthlyFirst2MonthsPromoCutoff(thursday);
      expect(cutoff.day()).toBe(4); // Thursday
      expect(cutoff.format('YYYY-MM-DD')).toBe('2026-04-02');
    });

    it('returns the upcoming Thursday when today is Friday', () => {
      // 2026-03-27 is a Friday
      const friday = dayjs.utc('2026-03-27T12:00:00Z');
      const cutoff = getKiloPassMonthlyFirst2MonthsPromoCutoff(friday);
      expect(cutoff.day()).toBe(4); // Thursday
      expect(cutoff.format('YYYY-MM-DD')).toBe('2026-04-02');
    });

    it('returns the upcoming Thursday when today is Wednesday', () => {
      // 2026-03-25 is a Wednesday
      const wednesday = dayjs.utc('2026-03-25T12:00:00Z');
      const cutoff = getKiloPassMonthlyFirst2MonthsPromoCutoff(wednesday);
      expect(cutoff.day()).toBe(4); // Thursday
      expect(cutoff.format('YYYY-MM-DD')).toBe('2026-03-26');
    });

    it('returns the upcoming Thursday when today is Sunday', () => {
      // 2026-03-22 is a Sunday
      const sunday = dayjs.utc('2026-03-22T12:00:00Z');
      const cutoff = getKiloPassMonthlyFirst2MonthsPromoCutoff(sunday);
      expect(cutoff.day()).toBe(4); // Thursday
      expect(cutoff.format('YYYY-MM-DD')).toBe('2026-03-26');
    });

    it('always has at least 1 day until cutoff', () => {
      // Test every day of the week
      for (let i = 0; i < 7; i++) {
        // 2026-03-22 is Sunday (day 0), iterate through the full week
        const date = dayjs.utc('2026-03-22').add(i, 'day');
        const cutoff = getKiloPassMonthlyFirst2MonthsPromoCutoff(date);
        expect(cutoff.isAfter(date)).toBe(true);
      }
    });

    it('sets the time to 06:59:59 UTC (11:59:59 PM PST)', () => {
      const date = dayjs.utc('2026-03-23T00:00:00Z');
      const cutoff = getKiloPassMonthlyFirst2MonthsPromoCutoff(date);
      expect(cutoff.format('HH:mm:ss')).toBe('06:59:59');
    });
  });
});
