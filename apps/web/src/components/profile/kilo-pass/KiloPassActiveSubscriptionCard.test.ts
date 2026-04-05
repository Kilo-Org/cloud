import { describe, expect, test } from '@jest/globals';
import { KiloPassCadence, KiloPassTier } from '@/lib/kilo-pass/enums';
import { getMonthlyPriceUsd } from '@/lib/kilo-pass/bonus';
import {
  computeRenewInfoRowModel,
  computeUsageProgressModel,
  computeNextBillingDateRowDateLabel,
} from './KiloPassActiveSubscriptionCard.logic';
import type {
  KiloPassActiveSubscriptionCardLogicSubscription,
  KiloPassScheduledChange,
} from './KiloPassActiveSubscriptionCard.logic';
import { KiloPassScheduledChangeStatus } from '@/lib/kilo-pass/enums';

function buildSubscription(
  overrides: Partial<KiloPassActiveSubscriptionCardLogicSubscription>
): KiloPassActiveSubscriptionCardLogicSubscription {
  return {
    cadence: KiloPassCadence.Monthly,
    tier: KiloPassTier.Tier19,
    currentStreakMonths: 0,
    isFirstTimeSubscriberEver: false,
    startedAt: null,
    refillAt: null,
    nextBillingAt: null,
    currentPeriodBaseCreditsUsd: 19,
    currentPeriodUsageUsd: 0,
    currentPeriodBonusCreditsUsd: 0,
    isBonusUnlocked: false,
    ...overrides,
  };
}

function buildScheduledChange(
  overrides: Partial<NonNullable<KiloPassScheduledChange>>
): NonNullable<KiloPassScheduledChange> | null {
  const status: KiloPassScheduledChangeStatus =
    (overrides.status as KiloPassScheduledChangeStatus | undefined) ??
    KiloPassScheduledChangeStatus.Active;
  return {
    id: 'sc_1',
    fromTier: KiloPassTier.Tier19,
    fromCadence: KiloPassCadence.Monthly,
    toTier: KiloPassTier.Tier49,
    toCadence: KiloPassCadence.Monthly,
    effectiveAt: '2026-02-01T00:00:00Z',
    status,
    ...overrides,
  };
}

describe('KiloPassActiveSubscriptionCard.logic', () => {
  describe('computeRenewInfoRowModel()', () => {
    test('returns active_until when pending cancellation and refillAt exists', () => {
      const rows = computeRenewInfoRowModel({
        subscription: buildSubscription({
          cadence: KiloPassCadence.Monthly,
          tier: KiloPassTier.Tier19,
          refillAt: '2026-02-01T00:00:00Z',
        }),
        isPendingCancellation: true,
        scheduledChange: null,
        nowIso: '2026-01-31T00:00:00Z',
      });

      expect(rows).toHaveLength(1);
      expect(rows[0]?.kind).toBe('active_until');
      expect(rows[0]?.changeSuffix).toBe('');
    });

    test('yearly pending cancellation: active_until uses nextBillingAt (yearly period end)', () => {
      const rows = computeRenewInfoRowModel({
        subscription: buildSubscription({
          cadence: KiloPassCadence.Yearly,
          tier: KiloPassTier.Tier19,
          // In yearly cadence, refillAt is the upcoming monthly refill date.
          refillAt: '2026-02-01T00:00:00Z',
          // But Active-until should be the yearly billing period end.
          nextBillingAt: '2026-12-31T00:00:00Z',
        }),
        isPendingCancellation: true,
        scheduledChange: null,
        nowIso: '2026-01-31T00:00:00Z',
      });

      expect(rows.map(r => r.kind)).toEqual(['renews_and_adds_bonus', 'active_until']);
      const activeUntilRow = rows.find(r => r.kind === 'active_until');
      expect(activeUntilRow?.refillAtIso).toBe('2026-12-31T00:00:00Z');
    });

    test('yearly pending cancellation: hides the refill row when the upcoming refill is the last month', () => {
      const rows = computeRenewInfoRowModel({
        subscription: buildSubscription({
          cadence: KiloPassCadence.Yearly,
          tier: KiloPassTier.Tier19,
          refillAt: '2026-12-31T00:00:00Z',
          nextBillingAt: '2026-12-31T00:00:00Z',
        }),
        isPendingCancellation: true,
        scheduledChange: null,
        nowIso: '2026-12-30T00:00:00Z',
      });

      expect(rows).toHaveLength(1);
      expect(rows[0]?.kind).toBe('active_until');
      expect(rows[0]?.refillAtIso).toBe('2026-12-31T00:00:00Z');
    });

    test('applies scheduled change to next renew when yearly and effectiveAt matches refillAt', () => {
      const rows = computeRenewInfoRowModel({
        subscription: buildSubscription({
          cadence: KiloPassCadence.Yearly,
          tier: KiloPassTier.Tier19,
          currentStreakMonths: 3,
          refillAt: '2026-02-01T00:00:00Z',
          startedAt: '2025-01-01T00:00:00Z',
        }),
        isPendingCancellation: false,
        scheduledChange: buildScheduledChange({
          effectiveAt: '2026-02-01T00:00:00Z',
          fromCadence: KiloPassCadence.Yearly,
          toCadence: KiloPassCadence.Yearly,
          toTier: KiloPassTier.Tier49,
        }),
        nowIso: '2026-01-31T12:00:00Z',
      });

      expect(rows).toHaveLength(1);
      const model = rows[0];
      expect(model?.kind).toBe('renews_and_adds_bonus');
      if (model?.kind !== 'renews_and_adds_bonus') {
        throw new Error('expected renews_and_adds_bonus');
      }
      expect(model.baseUsd).toBeGreaterThan(0);
      expect(model.bonusUsd).toBeGreaterThan(0);
      expect(model.changeSuffix).toBe('');
      expect(model.labelPrefix).toMatch(/^Refills in \d+ day/);

      // Regression guard: for yearly cadence, scheduled changes should only apply when
      // effectiveAt matches refillAt.
      expect(model.baseUsd).toBe(getMonthlyPriceUsd(KiloPassTier.Tier49));
    });

    test('does not apply scheduled change to next renew when yearly and effectiveAt does not match refillAt', () => {
      const rows = computeRenewInfoRowModel({
        subscription: buildSubscription({
          cadence: KiloPassCadence.Yearly,
          tier: KiloPassTier.Tier19,
          currentStreakMonths: 3,
          refillAt: '2026-02-01T00:00:00Z',
          startedAt: '2025-01-01T00:00:00Z',
        }),
        isPendingCancellation: false,
        scheduledChange: buildScheduledChange({
          effectiveAt: '2026-03-01T00:00:00Z',
          fromCadence: KiloPassCadence.Yearly,
          toCadence: KiloPassCadence.Yearly,
          toTier: KiloPassTier.Tier49,
        }),
        nowIso: '2026-01-31T12:00:00Z',
      });

      expect(rows).toHaveLength(1);
      const model = rows[0];
      expect(model?.kind).toBe('renews_and_adds_bonus');
      if (model?.kind !== 'renews_and_adds_bonus') {
        throw new Error('expected renews_and_adds_bonus');
      }

      expect(model.baseUsd).toBe(getMonthlyPriceUsd(KiloPassTier.Tier19));
    });

    test('monthly cadence: applies scheduled change to next renew even when effectiveAt does not match refillAt', () => {
      const rows = computeRenewInfoRowModel({
        subscription: buildSubscription({
          cadence: KiloPassCadence.Monthly,
          tier: KiloPassTier.Tier19,
          refillAt: '2026-02-01T00:00:00Z',
          startedAt: '2026-01-01T00:00:00Z',
        }),
        isPendingCancellation: false,
        scheduledChange: buildScheduledChange({
          effectiveAt: '2026-03-01T00:00:00Z',
          fromCadence: KiloPassCadence.Monthly,
          toCadence: KiloPassCadence.Yearly,
          toTier: KiloPassTier.Tier49,
        }),
        nowIso: '2026-01-31T00:00:00Z',
      });

      expect(rows).toHaveLength(1);
      const model = rows[0];
      if (model?.kind !== 'renews_and_adds_bonus') {
        throw new Error('expected renews_and_adds_bonus');
      }

      expect(model.baseUsd).toBe(getMonthlyPriceUsd(KiloPassTier.Tier49));
      expect(model.changeSuffix).toContain('(change to');
      expect(model.labelPrefix).toContain(model.changeSuffix);
    });

    test('pluralizes day vs days in the label prefix', () => {
      const day1Rows = computeRenewInfoRowModel({
        subscription: buildSubscription({
          cadence: KiloPassCadence.Monthly,
          tier: KiloPassTier.Tier19,
          refillAt: '2026-02-01T00:00:00Z',
        }),
        isPendingCancellation: false,
        scheduledChange: null,
        nowIso: '2026-01-31T00:00:00Z',
      });

      expect(day1Rows).toHaveLength(1);
      const day1 = day1Rows[0];
      if (day1?.kind !== 'renews_and_adds_bonus') {
        throw new Error('expected renews_and_adds_bonus');
      }
      expect(day1.labelPrefix).toContain('Renews in 1 day');

      const day2Rows = computeRenewInfoRowModel({
        subscription: buildSubscription({
          cadence: KiloPassCadence.Monthly,
          tier: KiloPassTier.Tier19,
          refillAt: '2026-02-02T00:00:00Z',
        }),
        isPendingCancellation: false,
        scheduledChange: null,
        nowIso: '2026-01-31T00:00:00Z',
      });

      expect(day2Rows).toHaveLength(1);
      const day2 = day2Rows[0];
      if (day2?.kind !== 'renews_and_adds_bonus') {
        throw new Error('expected renews_and_adds_bonus');
      }
      expect(day2.labelPrefix).toContain('Renews in 2 days');
    });
  });

  describe('computeUsageProgressModel()', () => {
    test('returns null when baseUsd is not positive', () => {
      expect(
        computeUsageProgressModel({ baseUsd: 0, bonusUsd: 10, usageUsd: 5, isBonusUnlocked: false })
      ).toBeNull();
    });

    test('returns null when bonusUsd is not positive', () => {
      expect(
        computeUsageProgressModel({ baseUsd: 10, bonusUsd: 0, usageUsd: 5, isBonusUnlocked: false })
      ).toBeNull();
    });

    test('caps percentages at [0,100] and uses amber when bonus not unlocked', () => {
      const model = computeUsageProgressModel({
        baseUsd: 20,
        bonusUsd: 10,
        usageUsd: 5,
        isBonusUnlocked: false,
      });

      expect(model).not.toBeNull();
      expect(model?.statusClass).toBe('text-amber-300');
      expect(model?.usagePctOfTotal).toBeGreaterThanOrEqual(0);
      expect(model?.usagePctOfTotal).toBeLessThanOrEqual(100);
      expect(model?.pctOfBaseInTotal).toBeCloseTo((20 / 30) * 100, 5);
    });

    test('uses red when over available', () => {
      const model = computeUsageProgressModel({
        baseUsd: 20,
        bonusUsd: 10,
        usageUsd: 31,
        isBonusUnlocked: true,
      });

      expect(model).not.toBeNull();
      expect(model?.isOverAvailable).toBe(true);
      expect(model?.statusClass).toBe('text-red-400');
    });

    test('uses emerald when bonus unlocked and not over available', () => {
      const model = computeUsageProgressModel({
        baseUsd: 20,
        bonusUsd: 10,
        usageUsd: 25,
        isBonusUnlocked: true,
      });

      expect(model).not.toBeNull();
      expect(model?.isOverAvailable).toBe(false);
      expect(model?.statusClass).toBe('text-emerald-300');
      expect(model?.bonusFillPct).toBeGreaterThan(0);
    });
  });

  describe('computeNextBillingDateRowDateLabel()', () => {
    test('returns null for non-yearly cadence', () => {
      const label = computeNextBillingDateRowDateLabel({
        subscriptionCadence: KiloPassCadence.Monthly,
        isPendingCancellation: false,
        nextBillingDateLabel: 'Jan 1, 2026',
        subscriptionTier: KiloPassTier.Tier19,
        scheduledChange: null,
      });
      expect(label).toBeNull();
    });

    test('returns the nextBillingDateLabel when no effectiveAt override is applicable', () => {
      const label = computeNextBillingDateRowDateLabel({
        subscriptionCadence: KiloPassCadence.Yearly,
        isPendingCancellation: false,
        nextBillingDateLabel: 'Jan 1, 2026',
        subscriptionTier: KiloPassTier.Tier19,
        scheduledChange: buildScheduledChange({
          fromTier: KiloPassTier.Tier19,
          toTier: KiloPassTier.Tier19,
          fromCadence: KiloPassCadence.Yearly,
          toCadence: KiloPassCadence.Monthly,
          effectiveAt: '2025-12-15T00:00:00Z',
        }),
      });
      expect(label).toBe('Jan 1, 2026');
    });
  });
});
