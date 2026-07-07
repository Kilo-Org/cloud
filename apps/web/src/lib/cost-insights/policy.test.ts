import {
  COST_INSIGHT_ANOMALY_FLOOR_MICRODOLLARS,
  COST_INSIGHT_STARTER_ANOMALY_FLOOR_MICRODOLLARS,
  MICRODOLLARS_PER_USD,
  calculateAnomalyPolicy,
  formatSpendThresholdUsd,
  parseSpendThresholdUsd,
  requireSafeMicrodollars,
} from './policy';

describe('Cost Insights policy', () => {
  describe('parseSpendThresholdUsd', () => {
    it('returns null for blank thresholds', () => {
      expect(parseSpendThresholdUsd(null)).toBeNull();
      expect(parseSpendThresholdUsd('   ')).toBeNull();
    });

    it('parses cents precision to microdollars', () => {
      expect(parseSpendThresholdUsd('25')).toBe(25 * MICRODOLLARS_PER_USD);
      expect(parseSpendThresholdUsd('25.50')).toBe(25_500_000);
      expect(parseSpendThresholdUsd('0.01')).toBe(10_000);
    });

    it('rejects invalid or zero values', () => {
      expect(() => parseSpendThresholdUsd('0')).toThrow('greater than $0.00');
      expect(() => parseSpendThresholdUsd('-1')).toThrow('positive USD amount');
      expect(() => parseSpendThresholdUsd('10.001')).toThrow('positive USD amount');
      expect(() => parseSpendThresholdUsd('1,000')).toThrow('positive USD amount');
    });

    it('accepts the largest cent-precision threshold that converts safely', () => {
      expect(parseSpendThresholdUsd('9007199254.74')).toBe(9_007_199_254_740_000);
    });

    it('rejects thresholds whose final microdollar value is unsafe', () => {
      expect(() => parseSpendThresholdUsd('9007199254.75')).toThrow(
        'Spend threshold is too large. Enter a smaller USD amount.'
      );
      expect(() => parseSpendThresholdUsd('999999999999999999999999.99')).toThrow(
        'Spend threshold is too large. Enter a smaller USD amount.'
      );
    });
  });

  describe('requireSafeMicrodollars', () => {
    it('requires a positive safe integer', () => {
      expect(requireSafeMicrodollars(1, 'Amount')).toBe(1);
      expect(() => requireSafeMicrodollars(0, 'Amount')).toThrow('positive safe integer');
      expect(() => requireSafeMicrodollars(Number.MAX_SAFE_INTEGER + 1, 'Amount')).toThrow(
        'positive safe integer'
      );
    });
  });

  describe('formatSpendThresholdUsd', () => {
    it('formats microdollars as fixed cents', () => {
      expect(formatSpendThresholdUsd(null)).toBe('');
      expect(formatSpendThresholdUsd(10_000)).toBe('0.01');
      expect(formatSpendThresholdUsd(25_500_000)).toBe('25.50');
    });
  });

  describe('calculateAnomalyPolicy', () => {
    it('uses starter threshold until enough buckets exist', () => {
      const policy = calculateAnomalyPolicy([1, 2, 3]);

      expect(policy.mode).toBe('starter');
      expect(policy.thresholdMicrodollars).toBe(COST_INSIGHT_STARTER_ANOMALY_FLOOR_MICRODOLLARS);
    });

    it('uses floor when historical spend is below floor', () => {
      const policy = calculateAnomalyPolicy(Array.from({ length: 24 }, () => 1_000_000));

      expect(policy.mode).toBe('available-history');
      expect(policy.thresholdMicrodollars).toBe(COST_INSIGHT_ANOMALY_FLOOR_MICRODOLLARS);
    });

    it('uses seven-day p95 multiplier when full history exists', () => {
      const values = Array.from({ length: 24 * 7 }, (_, index) => (index + 1) * 1_000_000);
      const policy = calculateAnomalyPolicy(values);

      expect(policy.mode).toBe('seven-day');
      expect(policy.baselineMicrodollars).toBe(160 * MICRODOLLARS_PER_USD);
      expect(policy.thresholdMicrodollars).toBe(480 * MICRODOLLARS_PER_USD);
    });
  });
});
