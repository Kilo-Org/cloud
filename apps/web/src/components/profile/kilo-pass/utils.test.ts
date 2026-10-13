import { describe, expect, test } from '@jest/globals';
import { KiloPassTier } from '@kilocode/web-shared/lib/kilo-pass/enums';
import { getMonthlyBonusPreview } from './utils';

const tiers = [KiloPassTier.Tier19, KiloPassTier.Tier49, KiloPassTier.Tier199];

describe('getMonthlyBonusPreview', () => {
  test.each(tiers)(
    'shows the new first-time monthly offer for marked subscriptions on %s',
    tier => {
      const preview = getMonthlyBonusPreview({
        tier,
        isFirstTimeSubscriberEver: true,
        subscriptionStartedAtIso: '2026-10-08T00:00:00Z',
        usesNewMonthlyBonusSchedule: true,
      });

      expect(preview.firstMonthPercent).toBe(0.1);
      expect(preview.secondMonthPercent).toBe(0.5);
      expect(preview.welcomeDescription).toBe(
        'First-time monthly subscribers receive 10% free bonus credits in the first month and 50% in the second month, then the regular bonus ramp.'
      );
    }
  );

  test.each([
    { startedAt: '2026-10-08T23:59:59.999Z', first: 0.5, second: 0.1 },
    { startedAt: '2026-10-09T00:00:00Z', first: 0.05, second: 0.5 },
    { startedAt: '2027-01-01T00:00:00Z', first: 0.05, second: 0.5 },
  ])(
    'preserves the offer for subscriptions starting at $startedAt',
    ({ startedAt, first, second }) => {
      const preview = getMonthlyBonusPreview({
        tier: KiloPassTier.Tier19,
        isFirstTimeSubscriberEver: true,
        subscriptionStartedAtIso: startedAt,
        usesNewMonthlyBonusSchedule: false,
      });

      expect(preview.firstMonthPercent).toBe(first);
      expect(preview.secondMonthPercent).toBe(second);
    }
  );

  test.each(tiers)('keeps the regular ramp for returning subscribers on %s', tier => {
    const preview = getMonthlyBonusPreview({
      tier,
      isFirstTimeSubscriberEver: false,
      subscriptionStartedAtIso: '2026-10-15T00:00:00Z',
      usesNewMonthlyBonusSchedule: true,
    });

    expect(preview.firstMonthPercent).toBe(0.05);
    expect(preview.secondMonthPercent).toBe(0.1);
  });
});
