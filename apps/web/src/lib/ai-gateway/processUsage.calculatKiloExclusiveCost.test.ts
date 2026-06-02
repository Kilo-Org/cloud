import { test, describe, expect } from '@jest/globals';
import { calculateKiloExclusiveCost_mUsd } from './processUsage';
import type { JustTheCostsUsageStats } from './processUsage.types';
import type { KiloExclusiveModel } from '@/lib/ai-gateway/providers/kilo-exclusive-model';
import { claude_opus_4_7_stealth_model } from '@/lib/ai-gateway/providers/anthropic.constants';
import {
  qwen36_27b_model,
  qwen36_flash_model,
  qwen36_max_preview_model,
  qwen36_plus_model,
  qwen37_max_model,
  qwen37_plus_model,
} from '@/lib/ai-gateway/providers/qwen';

const makeUsage = (overrides: Partial<JustTheCostsUsageStats> = {}): JustTheCostsUsageStats => ({
  cost_mUsd: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheWriteTokens: 0,
  cacheHitTokens: 0,
  is_byok: false,
  ...overrides,
});

describe('calculatKiloExclusiveCost_mUsd with qwen3.7-max', () => {
  test('uses direct Alibaba pricing with the Kilo discount', () => {
    const result = calculateKiloExclusiveCost_mUsd(
      qwen37_max_model,
      makeUsage({ inputTokens: 100_000, outputTokens: 10_000 })
    );

    expect(result).toBe(Math.round(100_000 * 1.625 + 10_000 * 4.875));
  });

  test('charges explicit cache reads and writes at discounted rates', () => {
    const result = calculateKiloExclusiveCost_mUsd(
      qwen37_max_model,
      makeUsage({ inputTokens: 100_000, cacheHitTokens: 20_000, cacheWriteTokens: 30_000 })
    );

    expect(result).toBe(Math.round(50_000 * 1.625 + 20_000 * 0.1625 + 30_000 * 2.03125));
  });
});

describe('calculatKiloExclusiveCost_mUsd with qwen3.7-plus', () => {
  test('uses direct Alibaba pricing with the Kilo discount in the <=256k tier', () => {
    const result = calculateKiloExclusiveCost_mUsd(
      qwen37_plus_model,
      makeUsage({ inputTokens: 100_000, outputTokens: 10_000 })
    );

    expect(result).toBe(Math.round(100_000 * 0.26 + 10_000 * 1.04));
  });

  test('charges explicit cache reads and writes at discounted rates', () => {
    const result = calculateKiloExclusiveCost_mUsd(
      qwen37_plus_model,
      makeUsage({ inputTokens: 100_000, cacheHitTokens: 20_000, cacheWriteTokens: 30_000 })
    );

    expect(result).toBe(Math.round(50_000 * 0.26 + 20_000 * 0.026 + 30_000 * 0.325));
  });

  test('uses direct Alibaba pricing with the Kilo discount in the >256k tier', () => {
    const result = calculateKiloExclusiveCost_mUsd(
      qwen37_plus_model,
      makeUsage({ inputTokens: 300_000, outputTokens: 10_000 })
    );

    expect(result).toBe(Math.round(300_000 * 0.78 + 10_000 * 3.12));
  });

  test('moves to the long-context tier above the 256k boundary', () => {
    expect(
      calculateKiloExclusiveCost_mUsd(qwen37_plus_model, makeUsage({ inputTokens: 262_144 }))
    ).toBe(Math.round(262_144 * 0.26));
    expect(
      calculateKiloExclusiveCost_mUsd(qwen37_plus_model, makeUsage({ inputTokens: 262_145 }))
    ).toBe(Math.round(262_145 * 0.78));
  });
});

describe('calculatKiloExclusiveCost_mUsd with qwen3.6-plus', () => {
  // Pre-discount prices from Qwen pricing page (35% Kilo discount applied in code):
  //
  // Input<=256k tier:
  //   Input: $0.5/1M  → $0.325/1M   CacheWrite: $0.625/1M → $0.40625/1M
  //   CacheRead: $0.05/1M → $0.0325/1M   Output: $3/1M → $1.95/1M
  //
  // 256k<Input<=1M tier:
  //   Input: $2/1M → $1.3/1M   CacheWrite: $2.5/1M → $1.625/1M
  //   CacheRead: $0.2/1M → $0.13/1M   Output: $6/1M → $3.9/1M

  test('returns 0 when model has no pricing', () => {
    const model: KiloExclusiveModel = {
      ...qwen36_plus_model,
      pricing: null,
    };
    const result = calculateKiloExclusiveCost_mUsd(model, makeUsage({ inputTokens: 1000 }));
    expect(result).toBe(0);
  });

  test('input-only cost in <=256k tier', () => {
    // 100k uncached input tokens at $0.325/1M = 100_000 * 0.325 = 32_500 mUsd
    const result = calculateKiloExclusiveCost_mUsd(
      qwen36_plus_model,
      makeUsage({ inputTokens: 100_000 })
    );
    expect(result).toBe(32_500);
  });

  test('output-only cost in <=256k tier', () => {
    // 50k output tokens at $1.95/1M = 50_000 * 1.95 = 97_500 mUsd
    const result = calculateKiloExclusiveCost_mUsd(
      qwen36_plus_model,
      makeUsage({ outputTokens: 50_000 })
    );
    expect(result).toBe(97_500);
  });

  test('cache read cost in <=256k tier', () => {
    // 200k input tokens, all cache hits → uncached=0, cacheHit=200k
    // cacheHit: 200_000 * 0.0325 = 6_500 mUsd
    const result = calculateKiloExclusiveCost_mUsd(
      qwen36_plus_model,
      makeUsage({ inputTokens: 200_000, cacheHitTokens: 200_000 })
    );
    expect(result).toBe(6_500);
  });

  test('cache write cost in <=256k tier', () => {
    // 200k input tokens, all cache writes → uncached=0, cacheWrite=200k
    // cacheWrite: 200_000 * 0.40625 = 81_250 mUsd
    const result = calculateKiloExclusiveCost_mUsd(
      qwen36_plus_model,
      makeUsage({ inputTokens: 200_000, cacheWriteTokens: 200_000 })
    );
    expect(result).toBe(81_250);
  });

  test('mixed usage in <=256k tier', () => {
    // 100k input, 20k cache hit, 30k cache write → 50k uncached
    // total input = 50k + 30k + 20k = 100k (<=256k)
    // uncached: 50_000 * 0.325 = 16_250
    // output:   10_000 * 1.95  = 19_500
    // cacheHit: 20_000 * 0.0325 = 650
    // cacheWrite: 30_000 * 0.40625 = 12_187.5
    // total = 48_587.5 → 48_588
    const result = calculateKiloExclusiveCost_mUsd(
      qwen36_plus_model,
      makeUsage({
        inputTokens: 100_000,
        outputTokens: 10_000,
        cacheHitTokens: 20_000,
        cacheWriteTokens: 30_000,
      })
    );
    expect(result).toBe(48_588);
  });

  test('input-only cost in >256k tier', () => {
    // 300k uncached input tokens, total input = 300k (>256k)
    // uncached: 300_000 * 1.3 = 390_000 mUsd
    const result = calculateKiloExclusiveCost_mUsd(
      qwen36_plus_model,
      makeUsage({ inputTokens: 300_000 })
    );
    expect(result).toBe(390_000);
  });

  test('output cost in >256k tier', () => {
    // 300k input + 50k output, total input = 300k (>256k)
    // uncached: 300_000 * 1.3 = 390_000
    // output:    50_000 * 3.9 = 195_000
    // total = 585_000
    const result = calculateKiloExclusiveCost_mUsd(
      qwen36_plus_model,
      makeUsage({ inputTokens: 300_000, outputTokens: 50_000 })
    );
    expect(result).toBe(585_000);
  });

  test('cache read cost in >256k tier', () => {
    // 300k input with 100k cache hits → 200k uncached, total input = 300k (>256k)
    // uncached: 200_000 * 1.3  = 260_000
    // cacheHit: 100_000 * 0.13 = 13_000
    // total = 273_000
    const result = calculateKiloExclusiveCost_mUsd(
      qwen36_plus_model,
      makeUsage({ inputTokens: 300_000, cacheHitTokens: 100_000 })
    );
    expect(result).toBe(273_000);
  });

  test('cache write cost in >256k tier', () => {
    // 300k input with 100k cache writes → 200k uncached, total input = 300k (>256k)
    // uncached:    200_000 * 1.3   = 260_000
    // cacheWrite:  100_000 * 1.625 = 162_500
    // total = 422_500
    const result = calculateKiloExclusiveCost_mUsd(
      qwen36_plus_model,
      makeUsage({ inputTokens: 300_000, cacheWriteTokens: 100_000 })
    );
    expect(result).toBe(422_500);
  });

  test('mixed usage in >256k tier', () => {
    // 500k input, 50k cache hit, 100k cache write → 350k uncached
    // total input = 350k + 100k + 50k = 500k (>256k)
    // uncached:    350_000 * 1.3   = 455_000
    // output:       20_000 * 3.9   =  78_000
    // cacheHit:     50_000 * 0.13  =   6_500
    // cacheWrite:  100_000 * 1.625 = 162_500
    // total = 702_000
    const result = calculateKiloExclusiveCost_mUsd(
      qwen36_plus_model,
      makeUsage({
        inputTokens: 500_000,
        outputTokens: 20_000,
        cacheHitTokens: 50_000,
        cacheWriteTokens: 100_000,
      })
    );
    expect(result).toBe(702_000);
  });

  test('tier boundary: exactly 256k total input uses <=256k pricing', () => {
    // total input = 256 * 1024 = 262_144 (not > 256k, so <=256k tier)
    // uncached: 262_144 * 0.325 = 85_196.8 → 85_197
    const result = calculateKiloExclusiveCost_mUsd(
      qwen36_plus_model,
      makeUsage({ inputTokens: 262_144 })
    );
    expect(result).toBe(Math.round(262_144 * 0.325));
  });

  test('tier boundary: 256k+1 total input uses >256k pricing', () => {
    // total input = 256 * 1024 + 1 = 262_145 (>256k tier)
    // uncached: 262_145 * 1.3 = 340_788.5 → 340_789
    const result = calculateKiloExclusiveCost_mUsd(
      qwen36_plus_model,
      makeUsage({ inputTokens: 262_145 })
    );
    expect(result).toBe(Math.round(262_145 * 1.3));
  });

  test('zero tokens returns 0', () => {
    const result = calculateKiloExclusiveCost_mUsd(qwen36_plus_model, makeUsage());
    expect(result).toBe(0);
  });

  test('negative uncached input tokens falls back to total inputTokens', () => {
    // inputTokens=100, cacheHit=80, cacheWrite=50 → uncached = 100-80-50 = -30 (negative)
    // falls back to using inputTokens=100 as uncachedInputTokens
    // calculate_mUsd receives uncachedInputTokens=100 (fallback), cacheHit=80, cacheWrite=50
    // totalInput in calculate_mUsd = 100 + 50 + 80 = 230 (<=256k)
    // cost = 100*0.325 + 80*0.0325 + 50*0.40625 = 32.5 + 2.6 + 20.3125 = 55.4125 → 55
    const result = calculateKiloExclusiveCost_mUsd(
      qwen36_plus_model,
      makeUsage({
        inputTokens: 100,
        cacheHitTokens: 80,
        cacheWriteTokens: 50,
      })
    );
    expect(result).toBe(Math.round(100 * 0.325 + 80 * 0.0325 + 50 * 0.40625));
  });

  test('1M tokens input cost matches post-discount price', () => {
    // 1M uncached input at >256k tier: 1_000_000 * 1.3 = 1_300_000 mUsd
    // which is $1.3, the 35%-discounted rate from the pre-discount $2/1M
    const result = calculateKiloExclusiveCost_mUsd(
      qwen36_plus_model,
      makeUsage({ inputTokens: 1_000_000 })
    );
    expect(result).toBe(1_300_000);
  });

  test('1M tokens output cost matches post-discount price', () => {
    // 1M output at >256k tier (needs >256k input to trigger tier)
    // Use 300k input + 1M output
    // uncached: 300_000 * 1.3 = 390_000
    // output: 1_000_000 * 3.9 = 3_900_000
    // total = 4_290_000
    const result = calculateKiloExclusiveCost_mUsd(
      qwen36_plus_model,
      makeUsage({ inputTokens: 300_000, outputTokens: 1_000_000 })
    );
    expect(result).toBe(4_290_000);
  });
});

describe('calculatKiloExclusiveCost_mUsd with qwen3.6-flash', () => {
  // Pre-discount prices from Qwen pricing page (35% Kilo discount applied in code):
  //
  // Input<=256k tier:
  //   Input: $0.25/1M → $0.1625/1M   CacheWrite: $0.3125/1M → $0.203125/1M
  //   CacheRead: $0.025/1M → $0.01625/1M   Output: $1.5/1M → $0.975/1M
  //
  // 256k<Input<=1M tier:
  //   Input: $1/1M → $0.65/1M   CacheWrite: $1.25/1M → $0.8125/1M
  //   CacheRead: $0.1/1M → $0.065/1M   Output: $4/1M → $2.6/1M

  test('input-only cost in <=256k tier', () => {
    // 1M tokens * 0.1625 = 162_500 mUsd
    const result = calculateKiloExclusiveCost_mUsd(
      qwen36_flash_model,
      makeUsage({ inputTokens: 100_000 })
    );
    expect(result).toBe(Math.round(100_000 * 0.1625));
  });

  test('output cost in <=256k tier', () => {
    const result = calculateKiloExclusiveCost_mUsd(
      qwen36_flash_model,
      makeUsage({ outputTokens: 50_000 })
    );
    expect(result).toBe(Math.round(50_000 * 0.975));
  });

  test('mixed usage in <=256k tier', () => {
    // 100k input, 20k cache hit, 30k cache write → 50k uncached
    // total input = 50k + 30k + 20k = 100k (<=256k)
    const result = calculateKiloExclusiveCost_mUsd(
      qwen36_flash_model,
      makeUsage({
        inputTokens: 100_000,
        outputTokens: 10_000,
        cacheHitTokens: 20_000,
        cacheWriteTokens: 30_000,
      })
    );
    expect(result).toBe(
      Math.round(50_000 * 0.1625 + 10_000 * 0.975 + 20_000 * 0.01625 + 30_000 * 0.203125)
    );
  });

  test('input-only cost in >256k tier', () => {
    // 300k uncached input tokens > 256k → tier 2: 300_000 * 0.65
    const result = calculateKiloExclusiveCost_mUsd(
      qwen36_flash_model,
      makeUsage({ inputTokens: 300_000 })
    );
    expect(result).toBe(Math.round(300_000 * 0.65));
  });

  test('mixed usage in >256k tier', () => {
    // 500k input, 50k cache hit, 100k cache write → 350k uncached
    // total input = 500k (>256k)
    const result = calculateKiloExclusiveCost_mUsd(
      qwen36_flash_model,
      makeUsage({
        inputTokens: 500_000,
        outputTokens: 20_000,
        cacheHitTokens: 50_000,
        cacheWriteTokens: 100_000,
      })
    );
    expect(result).toBe(
      Math.round(350_000 * 0.65 + 20_000 * 2.6 + 50_000 * 0.065 + 100_000 * 0.8125)
    );
  });

  test('tier boundary: exactly 256k total input uses <=256k pricing', () => {
    const result = calculateKiloExclusiveCost_mUsd(
      qwen36_flash_model,
      makeUsage({ inputTokens: 256 * 1024 })
    );
    expect(result).toBe(Math.round(256 * 1024 * 0.1625));
  });

  test('tier boundary: 256k+1 total input uses >256k pricing', () => {
    const result = calculateKiloExclusiveCost_mUsd(
      qwen36_flash_model,
      makeUsage({ inputTokens: 256 * 1024 + 1 })
    );
    expect(result).toBe(Math.round((256 * 1024 + 1) * 0.65));
  });

  test('1M tokens input cost matches post-discount tier 2 price', () => {
    const result = calculateKiloExclusiveCost_mUsd(
      qwen36_flash_model,
      makeUsage({ inputTokens: 1_000_000 })
    );
    expect(result).toBe(1_000_000 * 0.65);
  });
});

describe('calculatKiloExclusiveCost_mUsd with qwen3.6-max-preview', () => {
  // Pre-discount prices from Qwen pricing page (35% Kilo discount applied in code):
  //
  // Input<=128k tier:
  //   Input: $1.3/1M → $0.845/1M   CacheWrite: $1.625/1M → $1.05625/1M
  //   CacheRead: $0.13/1M → $0.0845/1M   Output: $7.8/1M → $5.07/1M
  //
  // 128k<Input<=256k tier:
  //   Input: $2/1M → $1.3/1M   CacheWrite: $2.5/1M → $1.625/1M
  //   CacheRead: $0.2/1M → $0.13/1M   Output: $12/1M → $7.8/1M

  test('input-only cost in <=128k tier', () => {
    const result = calculateKiloExclusiveCost_mUsd(
      qwen36_max_preview_model,
      makeUsage({ inputTokens: 50_000 })
    );
    expect(result).toBe(Math.round(50_000 * 0.845));
  });

  test('output cost in <=128k tier', () => {
    const result = calculateKiloExclusiveCost_mUsd(
      qwen36_max_preview_model,
      makeUsage({ outputTokens: 10_000 })
    );
    expect(result).toBe(Math.round(10_000 * 5.07));
  });

  test('mixed usage in <=128k tier', () => {
    const result = calculateKiloExclusiveCost_mUsd(
      qwen36_max_preview_model,
      makeUsage({
        inputTokens: 100_000,
        outputTokens: 5_000,
        cacheHitTokens: 20_000,
        cacheWriteTokens: 30_000,
      })
    );
    expect(result).toBe(
      Math.round(50_000 * 0.845 + 5_000 * 5.07 + 20_000 * 0.0845 + 30_000 * 1.05625)
    );
  });

  test('input-only cost in >128k tier', () => {
    // 200k > 128k → tier 2
    const result = calculateKiloExclusiveCost_mUsd(
      qwen36_max_preview_model,
      makeUsage({ inputTokens: 200_000 })
    );
    expect(result).toBe(Math.round(200_000 * 1.3));
  });

  test('tier boundary: exactly 128k total input uses <=128k pricing', () => {
    const result = calculateKiloExclusiveCost_mUsd(
      qwen36_max_preview_model,
      makeUsage({ inputTokens: 128 * 1024 })
    );
    expect(result).toBe(Math.round(128 * 1024 * 0.845));
  });

  test('tier boundary: 128k+1 total input uses >128k pricing', () => {
    const result = calculateKiloExclusiveCost_mUsd(
      qwen36_max_preview_model,
      makeUsage({ inputTokens: 128 * 1024 + 1 })
    );
    expect(result).toBe(Math.round((128 * 1024 + 1) * 1.3));
  });

  test('256k tokens input cost uses >128k tier', () => {
    const result = calculateKiloExclusiveCost_mUsd(
      qwen36_max_preview_model,
      makeUsage({ inputTokens: 256 * 1024 })
    );
    expect(result).toBe(Math.round(256 * 1024 * 1.3));
  });
});

describe('calculatKiloExclusiveCost_mUsd with stealth Claude Opus 4.7', () => {
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

describe('calculatKiloExclusiveCost_mUsd with qwen3.6-27b', () => {
  // Pre-discount prices (35% Kilo discount applied in code):
  //   Input: $0.5/1M → $0.325/1M   Output: $5/1M → $3.25/1M

  test('input-only cost', () => {
    const result = calculateKiloExclusiveCost_mUsd(
      qwen36_27b_model,
      makeUsage({ inputTokens: 100_000 })
    );
    expect(result).toBe(Math.round(100_000 * 0.325));
  });

  test('output-only cost', () => {
    const result = calculateKiloExclusiveCost_mUsd(
      qwen36_27b_model,
      makeUsage({ outputTokens: 50_000 })
    );
    expect(result).toBe(Math.round(50_000 * 3.25));
  });

  test('cache hit falls back to prompt price when cache_read is null', () => {
    // no explicit cache_read price → uses prompt_per_million
    const result = calculateKiloExclusiveCost_mUsd(
      qwen36_27b_model,
      makeUsage({ inputTokens: 100_000, cacheHitTokens: 100_000 })
    );
    expect(result).toBe(Math.round(100_000 * 0.325));
  });

  test('pricing is flat regardless of input size', () => {
    const result = calculateKiloExclusiveCost_mUsd(
      qwen36_27b_model,
      makeUsage({ inputTokens: 250_000 })
    );
    expect(result).toBe(Math.round(250_000 * 0.325));
  });
});
