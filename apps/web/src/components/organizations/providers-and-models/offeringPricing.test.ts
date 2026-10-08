import { describe, expect, test } from '@jest/globals';
import { GEMINI_FLASH_CURRENT_MODEL_ID } from '@kilocode/web-shared/lib/ai-gateway/providers/google';
import { MISTRAL_LARGE_4_MODEL_ID } from '@kilocode/web-shared/lib/ai-gateway/providers/mistral.constants';
import { formatPrice } from '@/components/models/util';
import { getOfferingPricing } from '@/components/organizations/providers-and-models/offeringPricing';

describe('getOfferingPricing', () => {
  test('shows list prices for models without custom pricing', () => {
    expect(
      getOfferingPricing('openai/gpt-x', { prompt: '0.000001', completion: '0.000005' })
    ).toEqual({ promptPrice: '0.000001', completionPrice: '0.000005' });
  });

  test('undoes the OpenRouter discount for models without custom pricing', () => {
    const pricing = getOfferingPricing('openai/gpt-x', {
      prompt: '0.0000005',
      completion: '0.0000025',
      discount: 0.5,
    });
    expect(formatPrice(pricing.promptPrice)).toBe('$1.00/1M tokens');
    expect(formatPrice(pricing.completionPrice)).toBe('$5.00/1M tokens');
    expect(pricing.originalPromptPrice).toBeUndefined();
    expect(pricing.originalCompletionPrice).toBeUndefined();
  });

  test('shows the custom price with the list price as the original', () => {
    const pricing = getOfferingPricing(GEMINI_FLASH_CURRENT_MODEL_ID, {
      prompt: '0.0000015',
      completion: '0.0000075',
    });
    expect(formatPrice(pricing.promptPrice)).toBe('$0.75/1M tokens');
    expect(formatPrice(pricing.completionPrice)).toBe('$3.75/1M tokens');
    expect(pricing.originalPromptPrice).toBe('0.0000015');
    expect(pricing.originalCompletionPrice).toBe('0.0000075');
  });

  test('compares the custom price against the undiscounted list price', () => {
    const pricing = getOfferingPricing(MISTRAL_LARGE_4_MODEL_ID, {
      prompt: '0.00000068',
      completion: '0.00000209',
      discount: 0.5,
    });
    expect(formatPrice(pricing.promptPrice)).toBe('$0.68/1M tokens');
    expect(formatPrice(pricing.originalPromptPrice ?? '')).toBe('$1.36/1M tokens');
    expect(formatPrice(pricing.originalCompletionPrice ?? '')).toBe('$4.18/1M tokens');
  });

  test('omits the original price when the custom price is not lower', () => {
    const pricing = getOfferingPricing(GEMINI_FLASH_CURRENT_MODEL_ID, {
      prompt: '0.00000075',
      completion: '0.000002',
    });
    expect(formatPrice(pricing.promptPrice)).toBe('$0.75/1M tokens');
    expect(pricing.originalPromptPrice).toBeUndefined();
    expect(formatPrice(pricing.completionPrice)).toBe('$3.75/1M tokens');
    expect(pricing.originalCompletionPrice).toBeUndefined();
  });

  test('does not apply custom pricing to other variants of the model', () => {
    expect(
      getOfferingPricing(`${GEMINI_FLASH_CURRENT_MODEL_ID}:free`, { prompt: '0', completion: '0' })
    ).toEqual({ promptPrice: '0', completionPrice: '0' });
  });
});
