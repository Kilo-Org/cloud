import { KiloPassCadence, KiloPassTier } from '@/lib/kilo-pass/enums';
import {
  computeMonthlyCadenceBonusPercent,
  isKiloPassSelectionEligibleForKiloclawCommitUpsell,
} from './bonus';

import {
  KILO_PASS_FIRST_MONTH_PROMO_BONUS_PERCENT,
  KILO_PASS_MONTHLY_FIRST_2_MONTHS_PROMO_CUTOFF,
  KILO_PASS_TIER_CONFIG,
} from './constants';

describe('kilo pass bonus utilities', () => {
  describe('monthly ramp (non-promo)', () => {
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
  });

  describe('computeMonthlyCadenceBonusPercent', () => {
    it('keeps the second-month grandfather cutoff at midnight May 7 UTC', () => {
      expect(KILO_PASS_MONTHLY_FIRST_2_MONTHS_PROMO_CUTOFF.toISOString()).toBe(
        '2026-05-07T00:00:00.000Z'
      );
    });

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

    it('applies the first-month promo for first-time subscribers after the grandfather cutoff', () => {
      expect(
        computeMonthlyCadenceBonusPercent({
          tier: KiloPassTier.Tier19,
          streakMonths: 1,
          isFirstTimeSubscriberEver: true,
          subscriptionStartedAtIso: new Date(
            KILO_PASS_MONTHLY_FIRST_2_MONTHS_PROMO_CUTOFF.valueOf() + 1
          ).toISOString(),
        })
      ).toBeCloseTo(KILO_PASS_FIRST_MONTH_PROMO_BONUS_PERCENT);
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

    it('applies the first-month promo at the second-month grandfather cutoff', () => {
      expect(
        computeMonthlyCadenceBonusPercent({
          tier,
          streakMonths: 1,
          isFirstTimeSubscriberEver: true,
          subscriptionStartedAtIso: KILO_PASS_MONTHLY_FIRST_2_MONTHS_PROMO_CUTOFF.toISOString(),
        })
      ).toBe(KILO_PASS_FIRST_MONTH_PROMO_BONUS_PERCENT);
    });

    it('does not apply the second-month promo at the grandfather cutoff', () => {
      expect(
        computeMonthlyCadenceBonusPercent({
          tier,
          streakMonths: 2,
          isFirstTimeSubscriberEver: true,
          subscriptionStartedAtIso: KILO_PASS_MONTHLY_FIRST_2_MONTHS_PROMO_CUTOFF.toISOString(),
        })
      ).toBeCloseTo(
        KILO_PASS_TIER_CONFIG.tier_49.monthlyBaseBonusPercent +
          KILO_PASS_TIER_CONFIG.tier_49.monthlyStepBonusPercent
      );
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
