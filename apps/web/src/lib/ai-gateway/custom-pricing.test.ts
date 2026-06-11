import { describe, expect, test } from '@jest/globals';
import type { OpenRouterModel } from '@/lib/organizations/organization-types';
import {
  applyCustomPricingToModel,
  calculateCustomCost_mUsd,
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
      prompt: '999',
      completion: '999',
      input_cache_read: '999',
      input_cache_write: '999',
    },
    context_length: 1_000_000,
  };
}

const makeUsage = (overrides: Partial<Parameters<typeof calculateCustomCost_mUsd>[1]> = {}) => ({
  cost_mUsd: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheWriteTokens: 0,
  cacheHitTokens: 0,
  is_byok: false,
  ...overrides,
});

describe('custom model pricing', () => {
  test('replaces upstream Qwen3.7 Max pricing in the model list', () => {
    const model = applyCustomPricingToModel(makeModel(QWEN37_MAX_MODEL_ID));

    expect(model.name).toBe('Qwen: Qwen3.7 Max (50% off)');
    expect(model.pricing).toEqual({
      prompt: '0.000001250000',
      completion: '0.000003750000',
      input_cache_read: '0.000000125000',
      input_cache_write: '0.000001562500',
    });
  });

  test('replaces upstream Qwen3.7 Plus pricing in the model list', () => {
    const model = applyCustomPricingToModel({
      ...makeModel(QWEN37_PLUS_MODEL_ID),
      name: 'Qwen: Qwen3.7 Plus',
    });

    expect(model.name).toBe('Qwen: Qwen3.7 Plus (20% off)');
    expect(model.pricing).toEqual({
      prompt: '0.000000320000',
      completion: '0.000001280000',
      input_cache_read: '0.000000032000',
      input_cache_write: '0.000000400000',
    });
  });

  test('calculates Qwen3.7 Max usage without relying on upstream cost', () => {
    expect(
      calculateCustomCost_mUsd(
        QWEN37_MAX_MODEL_ID,
        makeUsage({
          inputTokens: 100_000,
          outputTokens: 10_000,
          cacheHitTokens: 20_000,
          cacheWriteTokens: 30_000,
        })
      )
    ).toBe(Math.round(50_000 * 1.25 + 10_000 * 3.75 + 20_000 * 0.125 + 30_000 * 1.5625));
  });

  test('calculates both Qwen3.7 Plus context tiers from token usage', () => {
    expect(
      calculateCustomCost_mUsd(
        QWEN37_PLUS_MODEL_ID,
        makeUsage({ inputTokens: 100_000, outputTokens: 10_000 })
      )
    ).toBe(Math.round(100_000 * 0.32 + 10_000 * 1.28));
    expect(
      calculateCustomCost_mUsd(
        QWEN37_PLUS_MODEL_ID,
        makeUsage({ inputTokens: 300_000, outputTokens: 10_000 })
      )
    ).toBe(Math.round(300_000 * 0.96 + 10_000 * 3.84));
  });

  test('leaves models without custom pricing unchanged', () => {
    const model = makeModel('qwen/another-model');

    expect(applyCustomPricingToModel(model)).toBe(model);
    expect(calculateCustomCost_mUsd(model.id, makeUsage())).toBeUndefined();
  });
});
