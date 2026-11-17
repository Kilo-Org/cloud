import { describe, expect, test } from '@jest/globals';
import { formatPrice } from '@/components/models/util';
import { getOfferingPricing } from '@/components/organizations/providers-and-models/offeringPricing';

describe('getOfferingPricing', () => {
  test('shows list prices', () => {
    expect(
      getOfferingPricing({
        prompt: '0.000001',
        completion: '0.000005',
      })
    ).toEqual({ promptPrice: '0.000001', completionPrice: '0.000005' });
  });

  test('undoes the OpenRouter discount', () => {
    const pricing = getOfferingPricing({
      prompt: '0.0000005',
      completion: '0.0000025',
      discount: 0.5,
    });
    expect(formatPrice(pricing.promptPrice)).toBe('$1.00/1M tokens');
    expect(formatPrice(pricing.completionPrice)).toBe('$5.00/1M tokens');
  });
});
