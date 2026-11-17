import { describe, expect, it } from '@jest/globals';
import {
  getModelDisplayPricing,
  maxEndpointPricing,
  undoPricingDiscount,
} from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/display-pricing';

describe('undoPricingDiscount', () => {
  it('reverses the discount and drops the field without exponential output', () => {
    const result = undoPricingDiscount({
      prompt: '0.00000006',
      completion: '0.0000006',
      input_cache_read: '0.000000015',
      discount: 0.7,
    });
    expect(result).toEqual({
      prompt: '0.000000200000',
      completion: '0.000002000000',
      input_cache_read: '0.000000050000',
    });
    expect('discount' in result).toBe(false);
    for (const value of Object.values(result)) {
      expect(value).not.toMatch(/e/i);
    }
  });

  it('leaves pricing untouched when there is no discount', () => {
    const pricing = { prompt: '0.000001', completion: '0.000005' };
    expect(undoPricingDiscount(pricing)).toBe(pricing);
  });

  it('leaves pricing untouched when the discount is zero', () => {
    const pricing = { prompt: '0.000001', completion: '0.000005', discount: 0 };
    expect(undoPricingDiscount(pricing)).toBe(pricing);
  });

  it('drops the field when the discount cannot be reversed', () => {
    const result = undoPricingDiscount({
      prompt: '0.000001',
      completion: '0.000005',
      discount: 1,
    });
    expect(result).toEqual({ prompt: '0.000001', completion: '0.000005' });
  });
});

describe('getModelDisplayPricing', () => {
  it('undoes endpoint discounts', () => {
    expect(
      getModelDisplayPricing({
        prompt: '0.000001',
        completion: '0.000004',
        input_cache_read: '0.0000001',
        discount: 0.5,
      })
    ).toEqual({
      prompt: '0.000002000000',
      completion: '0.000008000000',
      input_cache_read: '0.000000200000',
    });
  });

  it('returns undefined when there is no pricing', () => {
    expect(getModelDisplayPricing(undefined)).toBeUndefined();
  });
});

describe('maxEndpointPricing', () => {
  it('takes the higher of each price', () => {
    expect(
      maxEndpointPricing(
        { prompt: '0.000002', completion: '0.000003', input_cache_read: '0.0000002' },
        { prompt: '0.000001', completion: '0.000005', input_cache_read: '0.0000001' }
      )
    ).toEqual({ prompt: '0.000002', completion: '0.000005', input_cache_read: '0.0000002' });
  });

  it('compares prices numerically rather than as strings', () => {
    expect(
      maxEndpointPricing(
        { prompt: '0.0000009', completion: '0.00001' },
        { prompt: '0.000001', completion: '0.000009' }
      )
    ).toEqual({ prompt: '0.000001', completion: '0.00001' });
  });

  it('keeps prices only one side has', () => {
    expect(
      maxEndpointPricing(
        { prompt: '0.000001', completion: '0.000002', request: '0.01' },
        { prompt: '0.000001', completion: '0.000002', input_cache_write: '0.000003' }
      )
    ).toEqual({
      prompt: '0.000001',
      completion: '0.000002',
      request: '0.01',
      input_cache_write: '0.000003',
    });
  });

  it('ignores an unparsable price on the other side', () => {
    expect(
      maxEndpointPricing(
        { prompt: '0.000001', completion: '0.000002' },
        { prompt: 'n/a', completion: '0.000003' }
      )
    ).toEqual({ prompt: '0.000001', completion: '0.000003' });
  });

  it('does not modify its arguments', () => {
    const a = { prompt: '0.000001', completion: '0.000002' };
    const b = { prompt: '0.000002', completion: '0.000001' };
    maxEndpointPricing(a, b);
    expect(a).toEqual({ prompt: '0.000001', completion: '0.000002' });
    expect(b).toEqual({ prompt: '0.000002', completion: '0.000001' });
  });
});
