import { describe, expect, it } from '@jest/globals';
import { DEFAULT_HEALTH_PERIOD, parseHealthPeriod } from './health-period-preference';

describe('Cloud Agent health period preference', () => {
  it('restores every supported period preset', () => {
    for (const period of ['1h', '3h', '24h', '7d', '14d', '30d']) {
      expect(parseHealthPeriod(period)).toBe(period);
    }
  });

  it('defaults to the seven day period for absent or stale values', () => {
    expect(DEFAULT_HEALTH_PERIOD).toBe('7d');
    expect(parseHealthPeriod(null)).toBe(DEFAULT_HEALTH_PERIOD);
    expect(parseHealthPeriod('90d')).toBe(DEFAULT_HEALTH_PERIOD);
    expect(parseHealthPeriod('')).toBe(DEFAULT_HEALTH_PERIOD);
  });
});
