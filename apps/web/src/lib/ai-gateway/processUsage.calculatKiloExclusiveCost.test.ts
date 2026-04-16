import { test, describe, expect } from '@jest/globals';
import { calculateKiloExclusiveCost_mUsd } from './processUsage';
import type { JustTheCostsUsageStats } from './processUsage.types';
import type { KiloExclusiveModel } from '@/lib/ai-gateway/providers/kilo-exclusive-model';
import { qwen36_plus_model } from '@/lib/ai-gateway/providers/qwen';

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

  const makeUsage = (overrides: Partial<JustTheCostsUsageStats> = {}): JustTheCostsUsageStats => ({
    cost_mUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheWriteTokens: 0,
    cacheHitTokens: 0,
    is_byok: false,
    ...overrides,
  });

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
