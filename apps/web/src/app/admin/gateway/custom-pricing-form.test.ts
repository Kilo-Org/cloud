import { describe, expect, test } from '@jest/globals';
import type { CustomPricingModelConfig } from '@kilocode/db/schema-types';
import {
  customPricingToForm,
  EMPTY_CUSTOM_PRICING_FORM,
  parseCustomPricingForm,
  upsertCustomPricing,
} from '@/app/admin/gateway/custom-pricing-form';

const modelA: CustomPricingModelConfig = {
  model: 'provider/model-a',
  pricing: {
    prompt_per_million: 2,
    completion_per_million: 10,
    input_cache_read_per_million: 0.1,
    input_cache_write_per_million: null,
  },
  discountPercentage: 50,
  fallbackOnly: false,
};

describe('custom pricing form', () => {
  test('round-trips a model through the form', () => {
    expect(parseCustomPricingForm(customPricingToForm(modelA))).toEqual({ config: modelA });
  });

  test('treats blank cache prices as the prompt price and a blank discount as none', () => {
    expect(
      parseCustomPricingForm({
        ...EMPTY_CUSTOM_PRICING_FORM,
        model: ' provider/model-b ',
        prompt: '1.5',
        completion: '6',
      })
    ).toEqual({
      config: {
        model: 'provider/model-b',
        pricing: {
          prompt_per_million: 1.5,
          completion_per_million: 6,
          input_cache_read_per_million: null,
          input_cache_write_per_million: null,
        },
        fallbackOnly: false,
      },
    });
  });

  test.each([
    ['a missing prompt price', { prompt: '' }],
    ['a non-numeric completion price', { completion: 'abc' }],
    ['a negative cache price', { cacheRead: '-1' }],
    ['an out-of-range discount', { discountPercentage: '150' }],
    ['a missing model', { model: '' }],
  ])('rejects %s', (_name, patch) => {
    expect(parseCustomPricingForm({ ...customPricingToForm(modelA), ...patch })).toHaveProperty(
      'error'
    );
  });

  test('replaces an existing model in place and appends new models', () => {
    const modelB = { ...modelA, model: 'provider/model-b' };
    const updatedA = { ...modelA, discountPercentage: 25 };

    expect(upsertCustomPricing([modelA, modelB], updatedA)).toEqual([updatedA, modelB]);
    expect(upsertCustomPricing([modelA], modelB)).toEqual([modelA, modelB]);
  });
});
