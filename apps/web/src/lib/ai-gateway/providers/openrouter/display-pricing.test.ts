import { describe, expect, it } from '@jest/globals';
import { OPENROUTER_GPT56_PROMO_MODEL_IDS } from '@/lib/ai-gateway/providers/openai';
import {
  getModelDisplayPricing,
  undoPricingDiscount,
} from '@/lib/ai-gateway/providers/openrouter/display-pricing';

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

describe('OpenRouter GPT-5.6 promotion', () => {
  const discountedPricing = {
    prompt: '0.000001',
    completion: '0.000004',
    input_cache_read: '0.0000001',
    discount: 0.5,
  };

  it.each(OPENROUTER_GPT56_PROMO_MODEL_IDS)(
    'undoes discounted pricing while the promotion is disabled for %s',
    modelId => {
      expect(getModelDisplayPricing(modelId, discountedPricing)).toEqual({
        prompt: '0.000002000000',
        completion: '0.000008000000',
        input_cache_read: '0.000000200000',
      });
    }
  );

  it('continues to undo endpoint discounts for other models', () => {
    expect(getModelDisplayPricing('openai/gpt-5.6-sol', discountedPricing)).toEqual({
      prompt: '0.000002000000',
      completion: '0.000008000000',
      input_cache_read: '0.000000200000',
    });
  });
});
