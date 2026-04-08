import { describe, test, expect } from '@jest/globals';
import { calculateQwen36PlusCost } from './qwen';
import type { Usage } from './kilo-exclusive-model';

describe('calculateQwen36PlusCost', () => {
  describe('tier 1 pricing (<= 256k total input) - 35% discounted rates', () => {
    test('should calculate cost for basic usage within tier 1', () => {
      const usage: Usage = {
        inputTokens: 1000,
        outputTokens: 500,
        cacheWriteTokens: 0,
        cacheHitTokens: 0,
      };
      // (1000 * 0.000000325 + 500 * 0.00000195) * 1_000_000 = 1300 microdollars
      expect(calculateQwen36PlusCost(usage)).toBe(1300);
    });

    test('should calculate cost at exactly 256k threshold', () => {
      const usage: Usage = {
        inputTokens: 256 * 1024,
        outputTokens: 0,
        cacheWriteTokens: 0,
        cacheHitTokens: 0,
      };
      // 262144 * 0.000000325 * 1_000_000 = 85196.8 -> rounded to 85197 microdollars
      expect(calculateQwen36PlusCost(usage)).toBe(85197);
    });

    test('should include cache read and write costs', () => {
      const usage: Usage = {
        inputTokens: 1000,
        outputTokens: 500,
        cacheWriteTokens: 100,
        cacheHitTokens: 200,
      };
      // (1000 * 0.000000325 + 500 * 0.00000195 + 100 * 0.00000040625 + 200 * 0.0000000325) * 1_000_000
      // = 1347.125 -> rounded to 1347 microdollars
      expect(calculateQwen36PlusCost(usage)).toBe(1347);
    });
  });

  describe('tier 2 pricing (> 256k total input) - 35% discounted rates', () => {
    test('should calculate cost for usage above tier 1 threshold', () => {
      const usage: Usage = {
        inputTokens: 300_000,
        outputTokens: 1000,
        cacheWriteTokens: 0,
        cacheHitTokens: 0,
      };
      // (300000 * 0.0000013 + 1000 * 0.0000039) * 1_000_000 = 393900 microdollars
      expect(calculateQwen36PlusCost(usage)).toBe(393900);
    });

    test('should calculate cost with cache at tier 2 rates', () => {
      const usage: Usage = {
        inputTokens: 300_000,
        outputTokens: 1000,
        cacheWriteTokens: 500,
        cacheHitTokens: 1000,
      };
      // (300000 * 0.0000013 + 1000 * 0.0000039 + 500 * 0.000001625 + 1000 * 0.00000013) * 1_000_000
      // = 394842.5 -> rounded to 394843 microdollars
      expect(calculateQwen36PlusCost(usage)).toBe(394843);
    });
  });

  describe('edge cases', () => {
    test('should return 0 for zero usage', () => {
      const usage: Usage = {
        inputTokens: 0,
        outputTokens: 0,
        cacheWriteTokens: 0,
        cacheHitTokens: 0,
      };
      expect(calculateQwen36PlusCost(usage)).toBe(0);
    });

    test('should round to nearest microdollar', () => {
      const usage: Usage = {
        inputTokens: 1,
        outputTokens: 0,
        cacheWriteTokens: 0,
        cacheHitTokens: 0,
      };
      // 1 * 0.000000325 * 1_000_000 = 0.325 -> rounded to 0 microdollars
      expect(calculateQwen36PlusCost(usage)).toBe(0);
    });
  });
});
