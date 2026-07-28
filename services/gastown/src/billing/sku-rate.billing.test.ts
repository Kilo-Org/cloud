import { describe, expect, it } from 'vitest';
import { hourlyChargeFromRate } from './sku-rate.billing';

describe('hourlyChargeFromRate', () => {
  it('converts SKU cents per second to dollars per hour', () => {
    expect(hourlyChargeFromRate('0.033416666667')).toBeCloseTo(1.203, 6);
  });

  it.each(['0', '-1', 'not-a-number'])('rejects an invalid cents-per-second rate: %s', rate => {
    expect(hourlyChargeFromRate(rate)).toBeUndefined();
  });
});
