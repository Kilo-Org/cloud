import { describe, expect, test } from '@jest/globals';
import type { OpenRouterModel } from '@/lib/organizations/organization-types';
import {
  applyCustomPricingToCost_mUsd,
  applyCustomPricingToModel,
  QWEN37_MAX_MODEL_ID,
  QWEN37_PLUS_MODEL_ID,
} from './custom-pricing';

function makeModel(id: string): OpenRouterModel {
  return {
    id,
    name: 'Qwen: Qwen3.7 Max',
    created: 0,
    description: 'Qwen model',
    architecture: {
      input_modalities: ['text'],
      output_modalities: ['text'],
      tokenizer: 'Other',
    },
    top_provider: { is_moderated: false },
    pricing: {
      prompt: '0.0000025',
      completion: '0.0000075',
      input_cache_read: '0.00000025',
      input_cache_write: '0.000003125',
    },
    context_length: 1_000_000,
  };
}

describe('custom model pricing', () => {
  test('applies the Qwen3.7 Max discount to model-list pricing and name', () => {
    const model = applyCustomPricingToModel(makeModel(QWEN37_MAX_MODEL_ID));

    expect(model.name).toBe('Qwen: Qwen3.7 Max (50% off)');
    expect(model.pricing).toEqual({
      prompt: '0.000001250000',
      completion: '0.000003750000',
      input_cache_read: '0.000000125000',
      input_cache_write: '0.000001562500',
    });
  });

  test('applies custom usage pricing independently of the display percentage', () => {
    expect(applyCustomPricingToCost_mUsd(QWEN37_MAX_MODEL_ID, 1_001)).toBe(501);
    expect(applyCustomPricingToCost_mUsd(QWEN37_PLUS_MODEL_ID, 1_001)).toBe(801);
  });

  test('leaves models without custom pricing unchanged', () => {
    const model = makeModel('qwen/another-model');

    expect(applyCustomPricingToModel(model)).toBe(model);
    expect(applyCustomPricingToCost_mUsd(model.id, 1_001)).toBe(1_001);
  });
});
