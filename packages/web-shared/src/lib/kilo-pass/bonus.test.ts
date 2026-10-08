import { KiloPassCadence, KiloPassTier } from '@kilocode/web-shared/lib/kilo-pass/enums';
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

  describe('monthly welcome promo rollout', () => {
    const startedAtIso = '2026-10-08T10:16:13.000Z';

    it.each([KiloPassTier.Tier19, KiloPassTier.Tier49, KiloPassTier.Tier199])(
      'moves the welcome bonus to month 2 for new %s subscriptions',
      tier => {
        const bonuses = [1, 2, 3].map(streakMonths =>
          computeMonthlyCadenceBonusPercent({
            tier,
            streakMonths,
            isFirstTimeSubscriberEver: true,
            subscriptionStartedAtIso: startedAtIso,
          })
        );

        expect(bonuses[0]).toBeCloseTo(0.05);
        expect(bonuses[1]).toBe(0.5);
        expect(bonuses[2]).toBeCloseTo(0.15);
      }
    );

    it.each([
      ['2026-10-08T10:16:12.999Z', [0.5, 0.1]],
      ['2026-10-08T10:16:13.001Z', [0.05, 0.5]],
      ['2026-10-08 10:16:13+00', [0.05, 0.5]],
      ['2026-10-08T12:16:13+02:00', [0.05, 0.5]],
      [null, [0.5, 0.1]],
      ['not-a-timestamp', [0.5, 0.1]],
    ])('preserves the schedule boundary for start %s', (subscriptionStartedAtIso, expected) => {
      const bonuses = [1, 2].map(streakMonths =>
        computeMonthlyCadenceBonusPercent({
          tier: KiloPassTier.Tier19,
          streakMonths,
          isFirstTimeSubscriberEver: true,
          subscriptionStartedAtIso,
        })
      );

      expect(bonuses).toEqual(expected);
    });

    it('does not give returning subscribers the second-month welcome bonus', () => {
      expect(
        computeMonthlyCadenceBonusPercent({
          tier: KiloPassTier.Tier19,
          streakMonths: 2,
          isFirstTimeSubscriberEver: false,
          subscriptionStartedAtIso: startedAtIso,
        })
      ).toBeCloseTo(0.1);
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
