import { test, describe, expect } from '@jest/globals';
import { calculateKiloExclusiveCost_mUsd } from './processUsage';
import type { JustTheCostsUsageStats } from './processUsage.types';
import { claude_opus_4_7_stealth_model } from '@/lib/ai-gateway/providers/anthropic.constants';

const makeUsage = (overrides: Partial<JustTheCostsUsageStats> = {}): JustTheCostsUsageStats => ({
  cost_mUsd: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheWriteTokens: 0,
  cacheHitTokens: 0,
  is_byok: false,
  ...overrides,
});

describe('calculateKiloExclusiveCost_mUsd with stealth Claude Opus 4.7', () => {
  test('uses the 20% lower flat price for uncached tokens', () => {
    const result = calculateKiloExclusiveCost_mUsd(
      claude_opus_4_7_stealth_model,
      makeUsage({ inputTokens: 100_000, outputTokens: 10_000 })
    );
    expect(result).toBe(600_000);
  });

  test('uses the discounted Anthropic-compatible cache prices', () => {
    const result = calculateKiloExclusiveCost_mUsd(
      claude_opus_4_7_stealth_model,
      makeUsage({
        inputTokens: 150_000,
        outputTokens: 10_000,
        cacheHitTokens: 25_000,
        cacheWriteTokens: 25_000,
      })
    );
    expect(result).toBe(735_000);
  });
});
