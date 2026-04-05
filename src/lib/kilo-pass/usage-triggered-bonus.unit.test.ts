import { describe, expect, test } from '@jest/globals';

import { KiloPassTier } from '@/lib/kilo-pass/enums';
import {
  computeUsageTriggeredMonthlyBonusDecision,
  computeUsageTriggeredYearlyIssueMonth,
} from '@/lib/kilo-pass/usage-triggered-bonus';
import { KILO_PASS_MONTHLY_FIRST_2_MONTHS_PROMO_CUTOFF } from '@/lib/kilo-pass/constants';

describe('usage-triggered-bonus (unit)', () => {
  describe('computeUsageTriggeredMonthlyBonusDecision', () => {
    test('clamps streakMonths to at least 1', () => {
      const d = computeUsageTriggeredMonthlyBonusDecision({
        tier: KiloPassTier.Tier19,
        startedAtIso: null,
        currentStreakMonths: 0,
        isFirstTimeSubscriberEver: false,
        issueMonth: '2026-01-01',
      });

      expect(d.auditPayload).toEqual(
        expect.objectContaining({
          monthlyBonusDecision: expect.objectContaining({
            streakMonths: 1,
            issueMonth: '2026-01-01',
          }),
        })
      );
    });

    test('eligible promo => shouldIssueFirstMonthPromo=true, bonusKind=promo-50pct, and promo description', () => {
      const d = computeUsageTriggeredMonthlyBonusDecision({
        tier: KiloPassTier.Tier19,
        startedAtIso: new Date(
          KILO_PASS_MONTHLY_FIRST_2_MONTHS_PROMO_CUTOFF.valueOf() - 1
        ).toISOString(),
        currentStreakMonths: 1,
        isFirstTimeSubscriberEver: true,
        issueMonth: '2026-01-01',
      });

      expect(d.shouldIssueFirstMonthPromo).toBe(true);
      expect(d.bonusPercentApplied).toBeCloseTo(0.5);
      expect(d.description).toBe('Kilo Pass promo 50% bonus (tier_19, streak=1)');
      expect(d.auditPayload).toEqual(expect.objectContaining({ bonusKind: 'promo-50pct' }));
      expect(d.auditPayload).toEqual(
        expect.objectContaining({
          monthlyBonusDecision: expect.objectContaining({
            issueMonth: '2026-01-01',
            startedAt: expect.any(String),
            streakMonths: 1,
            bonusPercentApplied: 0.5,
          }),
        })
      );
    });

    test('ineligible at promo cutoff => uses ramp (not 50%) and bonusKind=monthly-ramp', () => {
      const d = computeUsageTriggeredMonthlyBonusDecision({
        tier: KiloPassTier.Tier49,
        startedAtIso: KILO_PASS_MONTHLY_FIRST_2_MONTHS_PROMO_CUTOFF.toISOString(),
        currentStreakMonths: 2,
        isFirstTimeSubscriberEver: true,
        issueMonth: '2026-02-01',
      });

      expect(d.shouldIssueFirstMonthPromo).toBe(false);
      expect(d.bonusPercentApplied).not.toBe(0.5);
      expect(d.description).toBe('Kilo Pass monthly bonus (tier_49, streak=2)');
      expect(d.auditPayload).toEqual(expect.objectContaining({ bonusKind: 'monthly-ramp' }));
    });
  });

  describe('computeUsageTriggeredYearlyIssueMonth', () => {
    test('uses nextYearlyIssueAt - 1 month as currentPeriodStart and issueMonth', () => {
      const r = computeUsageTriggeredYearlyIssueMonth({
        nextYearlyIssueAtIso: '2026-02-01T00:00:00.000Z',
        startedAtIso: '2026-01-01T00:00:00.000Z',
      });

      expect(r.currentPeriodStartIso).toBe('2026-01-01T00:00:00.000Z');
      expect(r.issueMonth).toBe('2026-01-01');
    });

    test('falls back to startedAt when nextYearlyIssueAt is null', () => {
      const r = computeUsageTriggeredYearlyIssueMonth({
        nextYearlyIssueAtIso: null,
        startedAtIso: '2026-05-20T12:34:56.000Z',
      });

      expect(r.currentPeriodStartIso).toBe('2026-05-20T12:34:56.000Z');
      expect(r.issueMonth).toBe('2026-05-01');
    });

    test('returns nulls when both nextYearlyIssueAt and startedAt are null', () => {
      const r = computeUsageTriggeredYearlyIssueMonth({
        nextYearlyIssueAtIso: null,
        startedAtIso: null,
      });

      expect(r).toEqual({ currentPeriodStartIso: null, issueMonth: null });
    });
  });
});
