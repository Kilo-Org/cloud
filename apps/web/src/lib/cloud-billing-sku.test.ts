import { describe, expect, it } from '@jest/globals';
import {
  cloudBillingSkuRateSchema,
  multiplyCloudBillingRate,
  normalizeCloudBillingSkuRate,
} from '@/lib/cloud-billing-sku';

describe('cloudBillingSkuRateSchema', () => {
  it.each([
    '1',
    '999999999999',
    '0.1',
    '0.000000000001',
    '999999999999.999999999999',
    '1.230000000000',
  ])('accepts exact positive decimal rate %s', rate => {
    expect(cloudBillingSkuRateSchema.parse(rate)).toBe(rate);
  });

  it.each([
    '0',
    '0.0',
    '0.000000000000',
    '-1',
    '+1',
    '.1',
    '1.',
    '01',
    '1e-6',
    '1000000000000',
    '0.0000000000001',
    ' 0.1 ',
    ' 0.03342',
    '0.03342 ',
  ])('rejects non-canonical or out-of-range rate %s', rate => {
    expect(cloudBillingSkuRateSchema.safeParse(rate).success).toBe(false);
  });
});

describe('normalizeCloudBillingSkuRate', () => {
  it.each([
    ['1', '1'],
    ['1.000000000000', '1'],
    ['1.230000000000', '1.23'],
    ['0.000007000000', '0.000007'],
    ['0.123456789012', '0.123456789012'],
  ])('normalizes %s to %s without numeric conversion', (rate, expected) => {
    expect(normalizeCloudBillingSkuRate(rate)).toBe(expected);
  });
});

describe('multiplyCloudBillingRate', () => {
  it.each([
    ['0.000007', 60, '0.00042'],
    ['0.000007', 3_600, '0.0252'],
    ['0.000007', 900, '0.0063'],
    ['0.333333333333', 3, '0.999999999999'],
    ['1.230000000000', 10, '12.3'],
    ['0.000000000001', 1_000_000_000, '0.001'],
    ['999999999999.999999999999', 0, '0'],
  ])('previews %s x %s exactly as %s cents', (rate, quantity, expected) => {
    expect(multiplyCloudBillingRate(rate, quantity)).toBe(expected);
  });

  it('validates the rate before multiplying', () => {
    expect(() => multiplyCloudBillingRate('0.0000000000001', 60)).toThrow();
  });
});
