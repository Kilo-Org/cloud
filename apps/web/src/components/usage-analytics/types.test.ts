import { isAdditiveMetric, type MetricKey } from './types';

describe('isAdditiveMetric', () => {
  it.each<MetricKey>(['cost', 'requests', 'tokens', 'inputTokens', 'outputTokens'])(
    'recognizes %s as additive',
    metric => {
      expect(isAdditiveMetric(metric)).toBe(true);
    }
  );

  it.each<MetricKey>([
    'errorRate',
    'avgLatencyMs',
    'avgGenerationTimeMs',
    'costPerRequest',
    'tokensPerRequest',
    'cacheHitRatio',
    'outputInputRatio',
  ])('recognizes %s as non-additive', metric => {
    expect(isAdditiveMetric(metric)).toBe(false);
  });
});
