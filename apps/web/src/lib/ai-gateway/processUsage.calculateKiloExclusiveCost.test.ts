import { test, describe, expect } from '@jest/globals';
import { calculateKiloExclusiveCost_mUsd } from './processUsage';
import type { JustTheCostsUsageStats } from './processUsage.types';
import { claude_opus_4_7_stealth_model } from '@/lib/ai-gateway/providers/anthropic.constants';
import { qwen37_max_model, qwen37_plus_model } from '@/lib/ai-gateway/providers/qwen';

const makeUsage = (overrides: Partial<JustTheCostsUsageStats> = {}): JustTheCostsUsageStats => ({
  cost_mUsd: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheWriteTokens: 0,
  cacheHitTokens: 0,
  is_byok: false,
  ...overrides,
});

describe('calculateKiloExclusiveCost_mUsd with qwen3.7-max', () => {
  test('uses direct Alibaba pricing with the 50% discount', () => {
    const result = calculateKiloExclusiveCost_mUsd(
      qwen37_max_model,
      makeUsage({ inputTokens: 100_000, outputTokens: 10_000 })
    );

    expect(result).toBe(Math.round(100_000 * 1.25 + 10_000 * 3.75));
  });

  test('charges explicit cache reads and writes at discounted rates', () => {
    const result = calculateKiloExclusiveCost_mUsd(
      qwen37_max_model,
      makeUsage({ inputTokens: 100_000, cacheHitTokens: 20_000, cacheWriteTokens: 30_000 })
    );

    expect(result).toBe(Math.round(50_000 * 1.25 + 20_000 * 0.125 + 30_000 * 1.5625));
  });
});

describe('calculateKiloExclusiveCost_mUsd with qwen3.7-plus', () => {
  test('uses direct Alibaba pricing with the 20% discount in the <=256k tier', () => {
    const result = calculateKiloExclusiveCost_mUsd(
      qwen37_plus_model,
      makeUsage({ inputTokens: 100_000, outputTokens: 10_000 })
    );

    expect(result).toBe(Math.round(100_000 * 0.32 + 10_000 * 1.28));
  });

  test('charges explicit cache reads and writes at discounted rates', () => {
    const result = calculateKiloExclusiveCost_mUsd(
      qwen37_plus_model,
      makeUsage({ inputTokens: 100_000, cacheHitTokens: 20_000, cacheWriteTokens: 30_000 })
    );

    expect(result).toBe(Math.round(50_000 * 0.32 + 20_000 * 0.032 + 30_000 * 0.4));
  });

  test('uses direct Alibaba pricing with the 20% discount in the >256k tier', () => {
    const result = calculateKiloExclusiveCost_mUsd(
      qwen37_plus_model,
      makeUsage({ inputTokens: 300_000, outputTokens: 10_000 })
    );

    expect(result).toBe(Math.round(300_000 * 0.96 + 10_000 * 3.84));
  });

  test('moves to the long-context tier above the 256k boundary', () => {
    expect(
      calculateKiloExclusiveCost_mUsd(qwen37_plus_model, makeUsage({ inputTokens: 262_144 }))
    ).toBe(Math.round(262_144 * 0.32));
    expect(
      calculateKiloExclusiveCost_mUsd(qwen37_plus_model, makeUsage({ inputTokens: 262_145 }))
    ).toBe(Math.round(262_145 * 0.96));
  });
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
