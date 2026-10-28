import { test, describe, expect } from '@jest/globals';
import { calculateKiloExclusiveCost_mUsd } from './processUsage';
import type { JustTheCostsUsageStats } from './processUsage.types';
import { paidStealthModelFixture } from '@kilocode/web-shared/tests/helpers/kilo-exclusive-models.helper';

const makeUsage = (overrides: Partial<JustTheCostsUsageStats> = {}): JustTheCostsUsageStats => ({
  cost_mUsd: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheWriteTokens: 0,
  cacheHitTokens: 0,
  is_byok: false,
  ...overrides,
});

const fallbackOnlyModel = {
  ...paidStealthModelFixture,
  pricing: paidStealthModelFixture.pricing && {
    ...paidStealthModelFixture.pricing,
    fallbackOnly: true,
  },
};

describe('calculateKiloExclusiveCost_mUsd with a paid stealth model', () => {
  test('uses the flat price for uncached tokens', () => {
    const result = calculateKiloExclusiveCost_mUsd(
      paidStealthModelFixture,
      makeUsage({ inputTokens: 100_000, outputTokens: 10_000, cost_mUsd: 999_000 })
    );
    expect(result).toBe(600_000);
  });

  test('uses the cache prices', () => {
    const result = calculateKiloExclusiveCost_mUsd(
      paidStealthModelFixture,
      makeUsage({
        inputTokens: 150_000,
        outputTokens: 10_000,
        cacheHitTokens: 25_000,
        cacheWriteTokens: 25_000,
      })
    );
    expect(result).toBe(735_000);
  });

  test('uses fallback-only pricing when market cost is missing', () => {
    const result = calculateKiloExclusiveCost_mUsd(
      fallbackOnlyModel,
      makeUsage({ inputTokens: 100_000, outputTokens: 10_000 })
    );
    expect(result).toBe(600_000);
  });

  test('preserves reported market cost with fallback-only pricing', () => {
    const result = calculateKiloExclusiveCost_mUsd(
      fallbackOnlyModel,
      makeUsage({ inputTokens: 100_000, outputTokens: 10_000, cost_mUsd: 123_000 })
    );
    expect(result).toBeUndefined();
  });
});
