import { describe, expect, it } from '@jest/globals';

import { recommendKiloPassTierFromAverageMonthlyUsageUsd } from '@/lib/kilo-pass/recommend-tier';
import { KiloPassTier } from '@/lib/kilo-pass/enums';

describe('recommendKiloPassTierFromAverageMonthlyUsageUsd', () => {
  it('recommends the middle tier when average usage is exactly 0 (edge case)', () => {
    expect(recommendKiloPassTierFromAverageMonthlyUsageUsd({ averageMonthlyUsageUsd: 0 })).toBe(
      KiloPassTier.Tier49
    );
  });

  it('recommends tier_19 when usage is below tier_19 price', () => {
    expect(recommendKiloPassTierFromAverageMonthlyUsageUsd({ averageMonthlyUsageUsd: 10 })).toBe(
      KiloPassTier.Tier19
    );
  });

  it('recommends tier_19 when usage equals tier_19 price', () => {
    expect(recommendKiloPassTierFromAverageMonthlyUsageUsd({ averageMonthlyUsageUsd: 19 })).toBe(
      KiloPassTier.Tier19
    );
  });

  it('recommends tier_49 when usage is between tier_19 and tier_49 prices', () => {
    expect(recommendKiloPassTierFromAverageMonthlyUsageUsd({ averageMonthlyUsageUsd: 39 })).toBe(
      KiloPassTier.Tier49
    );
  });

  it('recommends tier_49 when usage equals tier_49 price', () => {
    expect(recommendKiloPassTierFromAverageMonthlyUsageUsd({ averageMonthlyUsageUsd: 49 })).toBe(
      KiloPassTier.Tier49
    );
  });

  it('recommends tier_199 when usage is above tier_49 price', () => {
    expect(recommendKiloPassTierFromAverageMonthlyUsageUsd({ averageMonthlyUsageUsd: 50 })).toBe(
      KiloPassTier.Tier199
    );
  });

  it('recommends the top tier when usage exceeds the top tier price', () => {
    expect(recommendKiloPassTierFromAverageMonthlyUsageUsd({ averageMonthlyUsageUsd: 1000 })).toBe(
      KiloPassTier.Tier199
    );
  });
});
