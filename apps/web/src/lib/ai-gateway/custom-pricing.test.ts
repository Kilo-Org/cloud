import { describe, expect, test } from '@jest/globals';
import { captureMessage } from '@sentry/nextjs';
import type { OpenRouterModel } from '@/lib/organizations/organization-types';
import { GEMINI_FLASH_CURRENT_MODEL_ID } from '@/lib/ai-gateway/providers/google';
import { QWEN37_MAX_MODEL_ID, QWEN37_PLUS_MODEL_ID } from '@/lib/ai-gateway/providers/qwen';
import {
  applyCustomPricingToPricing,
  applyCustomPricingToModel,
  calculateCustomCost_mUsd,
} from './custom-pricing';

jest.mock('@sentry/nextjs', () => ({ captureMessage: jest.fn() }));

function makeModel(id: string): OpenRouterModel {
  return {
    id,
    name: 'Test model',
    created: 0,
    description: 'Test model',
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
  test('replaces upstream Gemini 3.8 Flash pricing with the promotional rates', () => {
    const model = applyCustomPricingToModel({
      ...makeModel(GEMINI_FLASH_CURRENT_MODEL_ID),
      name: 'Google: Gemini 3.8 Flash',
    });

    expect(model.name).toBe('Google: Gemini 3.8 Flash (50% off)');
    expect(model.pricing).toEqual({
      prompt: '0.000000750000',
      completion: '0.000003750000',
      input_cache_read: '0.000000075000',
      input_cache_write: '0.000000041667',
    });
    expect(
      calculateCustomCost_mUsd(
        GEMINI_FLASH_CURRENT_MODEL_ID,
        makeUsage({ inputTokens: 100, cost_mUsd: 999 })
      )
    ).toBe(Math.round(100 * 0.75));
  });

  test.each([QWEN37_MAX_MODEL_ID, QWEN37_PLUS_MODEL_ID])(
    'does not apply custom pricing to %s',
    modelId => {
      const model = makeModel(modelId);

      expect(applyCustomPricingToModel(model)).toBe(model);
      expect(applyCustomPricingToPricing(model.id, model.pricing)).toBe(model.pricing);
      expect(calculateCustomCost_mUsd(model.id, makeUsage())).toBeUndefined();
    }
  );

  test.each(['z-ai/glm-5.2', 'moonshotai/kimi-k3'])(
    'does not apply custom pricing to %s',
    modelId => {
      const model = makeModel(modelId);
      const usage = makeUsage({
        inputTokens: 100,
        outputTokens: 10,
        cacheHitTokens: 20,
        cacheWriteTokens: 30,
      });

      expect(applyCustomPricingToModel(model)).toBe(model);
      expect(applyCustomPricingToPricing(model.id, model.pricing)).toBe(model.pricing);
      expect(calculateCustomCost_mUsd(model.id, usage)).toBeUndefined();
      expect(calculateCustomCost_mUsd(model.id, { ...usage, cost_mUsd: 123 })).toBeUndefined();
    }
  );

  test('reports invalid negative uncached token counts', () => {
    const captureMessageMock = jest.mocked(captureMessage);
    captureMessageMock.mockClear();

    const cost_mUsd = calculateCustomCost_mUsd(
      GEMINI_FLASH_CURRENT_MODEL_ID,
      makeUsage({ inputTokens: 10, cacheHitTokens: 20 })
    );

    expect(cost_mUsd).toBe(Math.round(20 * 0.075));
    expect(captureMessageMock).toHaveBeenCalledWith(
      'SUSPICIOUS: negative uncached input tokens for custom pricing',
      expect.objectContaining({
        level: 'error',
        extra: expect.objectContaining({ model: GEMINI_FLASH_CURRENT_MODEL_ID }),
      })
    );
  });

  test('leaves models without custom pricing unchanged', () => {
    const model = makeModel('qwen/another-model');

    expect(applyCustomPricingToModel(model)).toBe(model);
    expect(calculateCustomCost_mUsd(model.id, makeUsage())).toBeUndefined();
  });
});
