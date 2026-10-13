import {
  KiloPassCadence,
  KiloPassTier,
  KiloPassWelcomePromoEligibilityReason,
} from '@kilocode/web-shared/lib/kilo-pass/enums';
import {
  computeMonthlyCadenceBonusPercent,
  getMonthlyWelcomePromoMonth,
  computeYearlyCadenceMonthlyBonusUsd,
  isKiloPassSelectionEligibleForKiloclawCommitUpsell,
} from './bonus';
import {
  computeMonthlyKiloPassBonusDecision,
  computeKiloPassBonusCreditsUsd,
} from './bonus-decision';

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

    it.each([KiloPassTier.Tier19, KiloPassTier.Tier49, KiloPassTier.Tier199])(
      'uses only the persisted marker for the new first-month schedule for %s',
      tier => {
        const schedules = [
          ['2026-05-01T00:00:00Z', [0.5, 0.1, 0.15]],
          ['2026-10-08T23:59:59.999Z', [0.5, 0.1, 0.15]],
          ['2026-10-09T00:00:00Z', [0.05, 0.5, 0.15]],
          ['2026-10-13T23:59:59.999Z', [0.05, 0.5, 0.15]],
          ['2026-10-14T00:00:00Z', [0.05, 0.5, 0.15]],
          ['2027-01-01T00:00:00Z', [0.05, 0.5, 0.15]],
          ['2100-01-01T00:00:00Z', [0.05, 0.5, 0.15]],
          ['2026-10-13T20:00:00-04:00', [0.05, 0.5, 0.15]],
          ['2026-10-14 00:00:00+00', [0.05, 0.5, 0.15]],
          [undefined, [0.5, 0.1, 0.15]],
          [null, [0.5, 0.1, 0.15]],
          ['', [0.5, 0.1, 0.15]],
          ['not-a-timestamp', [0.5, 0.1, 0.15]],
          ['2026-13-01T00:00:00Z', [0.5, 0.1, 0.15]],
        ] as const;
        for (const [subscriptionStartedAtIso, legacySchedule] of schedules) {
          expect(getMonthlyWelcomePromoMonth(subscriptionStartedAtIso, true)).toBe(2);
          for (const usesNewMonthlyBonusSchedule of [undefined, false, true]) {
            for (const isFirstTimeSubscriberEver of [true, false]) {
              for (const streakMonths of [1, 2, 3, 4, 8, 9, 100]) {
                const bonus = computeMonthlyCadenceBonusPercent({
                  tier,
                  streakMonths,
                  isFirstTimeSubscriberEver,
                  subscriptionStartedAtIso,
                  usesNewMonthlyBonusSchedule,
                });
                const schedule = usesNewMonthlyBonusSchedule ? [0.1, 0.5, 0.15] : legacySchedule;
                const expectedPercent =
                  isFirstTimeSubscriberEver && streakMonths <= 3
                    ? schedule[streakMonths - 1]
                    : Math.min(0.4, 0.05 * streakMonths);
                expect(bonus).toBeCloseTo(expectedPercent);
              }
            }
          }
        }
      }
    );

    it.each([
      [KiloPassWelcomePromoEligibilityReason.FirstPaymentFingerprintClaim, true],
      [KiloPassWelcomePromoEligibilityReason.MissingFingerprint, true],
      [KiloPassWelcomePromoEligibilityReason.NoSupportedFingerprint, true],
      [KiloPassWelcomePromoEligibilityReason.FingerprintPreviouslyClaimed, false],
      [KiloPassWelcomePromoEligibilityReason.NoPositiveSettlement, false],
      [KiloPassWelcomePromoEligibilityReason.SettlementUnresolved, false],
      [null, false],
      [undefined, false],
    ] as const)('retains payment eligibility for reason %s', (reason, eligible) => {
      for (const usesNewMonthlyBonusSchedule of [false, true]) {
        for (const isFirstTimeSubscriberEver of [true, false]) {
          for (const streakMonths of [1, 2]) {
            const decision = computeMonthlyKiloPassBonusDecision({
              tier: KiloPassTier.Tier19,
              startedAtIso: '2100-01-01T00:00:00Z',
              streakMonths,
              isFirstTimeSubscriberEver,
              usesNewMonthlyBonusSchedule,
              welcomePromoPolicy: 'settled-payment-required',
              welcomePromoEligibilityReason: reason,
            });
            const expected =
              eligible && isFirstTimeSubscriberEver
                ? [usesNewMonthlyBonusSchedule ? 0.1 : 0.05, 0.5][streakMonths - 1]
                : 0.05 * streakMonths;
            expect(decision.bonusPercentApplied).toBeCloseTo(expected);
            expect(decision.bonusUsd).toBeCloseTo(Math.round(1900 * expected) / 100);
            expect(decision.shouldIssueFirstMonthPromo).toBe(
              eligible && isFirstTimeSubscriberEver && streakMonths === 2
            );
            expect(decision.bonusKind).toBe(
              eligible && isFirstTimeSubscriberEver && streakMonths === 2
                ? 'promo-50pct'
                : 'monthly-ramp'
            );
          }
        }
      }
    });

    it('keeps account-history-only eligibility and yearly bonuses unchanged', () => {
      for (const usesNewMonthlyBonusSchedule of [false, true]) {
        for (const streakMonths of [1, 2, 3]) {
          const params = {
            tier: KiloPassTier.Tier19,
            startedAtIso: '2026-05-01T00:00:00Z',
            streakMonths,
            isFirstTimeSubscriberEver: true,
            usesNewMonthlyBonusSchedule,
            welcomePromoPolicy: 'account-history-only',
          } as const;
          expect(computeMonthlyKiloPassBonusDecision(params).bonusPercentApplied).toBeCloseTo(
            (usesNewMonthlyBonusSchedule ? [0.1, 0.5, 0.15] : [0.5, 0.1, 0.15])[streakMonths - 1]
          );
          expect(
            computeKiloPassBonusCreditsUsd({ ...params, cadence: KiloPassCadence.Monthly })
          ).toBe(computeMonthlyKiloPassBonusDecision(params).bonusUsd);
          expect(
            computeKiloPassBonusCreditsUsd({ ...params, cadence: KiloPassCadence.Yearly })
          ).toBe(9.5);
        }
      }
    });

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
