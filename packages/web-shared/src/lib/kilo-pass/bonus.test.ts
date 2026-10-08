import { KiloPassCadence, KiloPassTier } from '@kilocode/web-shared/lib/kilo-pass/enums';
import {
  computeMonthlyCadenceBonusPercent,
  getMonthlyWelcomePromoMonth,
  computeYearlyCadenceMonthlyBonusUsd,
  isKiloPassSelectionEligibleForKiloclawCommitUpsell,
} from './bonus';

import {
  KILO_PASS_MONTHLY_WELCOME_PROMO_SECOND_MONTH_CUTOFF,
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

  describe('monthly welcome promo cutoff', () => {
    it.each([
      ['2026-05-01T00:00:00Z', 1],
      ['2026-10-08T23:59:59.999Z', 1],
      ['2026-10-09T00:00:00.000Z', 2],
      ['2026-10-09T00:00:00.001Z', 2],
      ['2027-01-01T00:00:00Z', 2],
      ['2026-10-08 23:59:59.999+00', 1],
      ['2026-10-09 00:00:00+00', 2],
      ['2026-10-08T20:00:00-04:00', 2],
      [null, 1],
      [undefined, 1],
      ['', 1],
      ['not-a-timestamp', 1],
      ['2026-13-01T00:00:00Z', 1],
      ['2026-10-99T00:00:00Z', 1],
    ] as const)('selects promo month %s => %s', (startedAtIso, expectedMonth) => {
      expect(getMonthlyWelcomePromoMonth(startedAtIso)).toBe(expectedMonth);
    });

    it.each([KiloPassTier.Tier19, KiloPassTier.Tier49, KiloPassTier.Tier199])(
      'uses the start timestamp and normal ramp for %s',
      tier => {
        for (const subscriptionStartedAtIso of [
          '2026-05-01T00:00:00Z',
          '2026-10-08T23:59:59.999Z',
          KILO_PASS_MONTHLY_WELCOME_PROMO_SECOND_MONTH_CUTOFF.toISOString(),
          '2026-10-09T00:00:00.001Z',
          null,
          'not-a-timestamp',
        ]) {
          for (const isFirstTimeSubscriberEver of [false, true]) {
            const bonuses = [1, 2, 3].map(streakMonths =>
              computeMonthlyCadenceBonusPercent({
                tier,
                streakMonths,
                isFirstTimeSubscriberEver,
                subscriptionStartedAtIso,
              })
            );
            const expected = !isFirstTimeSubscriberEver
              ? [0.05, 0.1, 0.15]
              : getMonthlyWelcomePromoMonth(subscriptionStartedAtIso) === 1
                ? [0.5, 0.1, 0.15]
                : [0.05, 0.5, 0.15];
            bonuses.forEach((bonus, index) => expect(bonus).toBeCloseTo(expected[index]));
          }
        }
      }
    );

    it('rejects streak months below 1', () => {
      expect(() =>
        computeMonthlyCadenceBonusPercent({
          tier: KiloPassTier.Tier19,
          streakMonths: 0,
          isFirstTimeSubscriberEver: true,
        })
      ).toThrow('streakMonths must be >= 1');
    });

    it.each([KiloPassTier.Tier19, KiloPassTier.Tier49, KiloPassTier.Tier199])(
      'leaves yearly %s bonuses at 50%',
      tier => {
        expect(computeYearlyCadenceMonthlyBonusUsd(tier)).toBe(
          KILO_PASS_TIER_CONFIG[tier].monthlyPriceUsd * 0.5
        );
      }
    );
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
