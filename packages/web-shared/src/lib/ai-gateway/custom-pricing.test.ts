import { describe, expect, test } from '@jest/globals';
import { captureMessage } from '@sentry/nextjs';
import type { OpenRouterModel } from '@kilocode/web-shared/lib/organizations/organization-types';
import {
  GEMINI_4_ARGON_MODEL_ID,
  GEMINI_FLASH_CURRENT_MODEL_ID,
} from '@kilocode/web-shared/lib/ai-gateway/providers/google';
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

const NO_CONFIGURED_PRICING = {};

const configuredPricing = {
  pricing: [
    {
      start_context_length: 0,
      pricing: {
        prompt_per_million: 0.5,
        completion_per_million: 2,
        input_cache_read_per_million: null,
        input_cache_write_per_million: null,
      },
    },
  ],
  discountPercentage: 20,
} as const;

describe('custom model pricing', () => {
  test('replaces upstream Gemini 3.8 Flash pricing with the promotional rates', () => {
    const model = applyCustomPricingToModel(
      {
        ...makeModel(GEMINI_FLASH_CURRENT_MODEL_ID),
        name: 'Google: Gemini 3.8 Flash',
      },
      NO_CONFIGURED_PRICING
    );

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
        makeUsage({ inputTokens: 100, cost_mUsd: 999 }),
        NO_CONFIGURED_PRICING
      )
    ).toBe(Math.round(100 * 0.75));
  });

  test('replaces upstream Gemini 4 Argon pricing with the promotional rates', () => {
    const model = applyCustomPricingToModel(
      {
        ...makeModel(GEMINI_4_ARGON_MODEL_ID),
        name: 'Google: Gemini 4 Argon',
      },
      NO_CONFIGURED_PRICING
    );

    expect(model.name).toBe('Google: Gemini 4 Argon (50% off)');
    expect(model.pricing).toEqual({
      prompt: '0.000002000000',
      completion: '0.000010000000',
      input_cache_read: '0.000000100000',
      input_cache_write: '0.000000187500',
    });
    expect(
      calculateCustomCost_mUsd(
        GEMINI_4_ARGON_MODEL_ID,
        makeUsage({
          inputTokens: 1_000,
          outputTokens: 100,
          cacheHitTokens: 200,
          cacheWriteTokens: 300,
          cost_mUsd: 999,
        }),
        NO_CONFIGURED_PRICING
      )
    ).toBe(Math.round(500 * 2 + 100 * 10 + 200 * 0.1 + 300 * 0.1875));
  });

  test.each(['qwen/qwen3.7-max', 'qwen/qwen3.7-plus', 'mistralai/mistral-large-4-0'])(
    'does not apply custom pricing to %s',
    modelId => {
      const model = makeModel(modelId);

      expect(applyCustomPricingToModel(model, NO_CONFIGURED_PRICING)).toBe(model);
      expect(applyCustomPricingToPricing(model.id, model.pricing, NO_CONFIGURED_PRICING)).toBe(
        model.pricing
      );
      expect(
        calculateCustomCost_mUsd(model.id, makeUsage(), NO_CONFIGURED_PRICING)
      ).toBeUndefined();
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

      expect(applyCustomPricingToModel(model, NO_CONFIGURED_PRICING)).toBe(model);
      expect(applyCustomPricingToPricing(model.id, model.pricing, NO_CONFIGURED_PRICING)).toBe(
        model.pricing
      );
      expect(calculateCustomCost_mUsd(model.id, usage, NO_CONFIGURED_PRICING)).toBeUndefined();
      expect(
        calculateCustomCost_mUsd(model.id, { ...usage, cost_mUsd: 123 }, NO_CONFIGURED_PRICING)
      ).toBeUndefined();
    }
  );

  test('reports invalid negative uncached token counts', () => {
    const captureMessageMock = jest.mocked(captureMessage);
    captureMessageMock.mockClear();

    const cost_mUsd = calculateCustomCost_mUsd(
      GEMINI_FLASH_CURRENT_MODEL_ID,
      makeUsage({ inputTokens: 10, cacheHitTokens: 20 }),
      NO_CONFIGURED_PRICING
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

    expect(applyCustomPricingToModel(model, NO_CONFIGURED_PRICING)).toBe(model);
    expect(calculateCustomCost_mUsd(model.id, makeUsage(), NO_CONFIGURED_PRICING)).toBeUndefined();
  });

  test('prefers admin-configured pricing over the built-in pricing', () => {
    const configured = { [GEMINI_FLASH_CURRENT_MODEL_ID]: configuredPricing };
    const model = applyCustomPricingToModel(
      { ...makeModel(GEMINI_FLASH_CURRENT_MODEL_ID), name: 'Google: Gemini 3.8 Flash' },
      configured
    );

    expect(model.name).toBe('Google: Gemini 3.8 Flash (20% off)');
    expect(model.pricing.prompt).toBe('0.000000500000');
    expect(
      calculateCustomCost_mUsd(
        GEMINI_FLASH_CURRENT_MODEL_ID,
        makeUsage({ inputTokens: 100, outputTokens: 10, cost_mUsd: 999 }),
        configured
      )
    ).toBe(Math.round(100 * 0.5 + 10 * 2));
  });

  test('falls back to built-in pricing for models without configured pricing', () => {
    const configured = { 'provider/configured-model': configuredPricing };

    expect(
      calculateCustomCost_mUsd(
        GEMINI_4_ARGON_MODEL_ID,
        makeUsage({ inputTokens: 100, cost_mUsd: 999 }),
        configured
      )
    ).toBe(Math.round(100 * 2));
    expect(
      applyCustomPricingToPricing(
        'provider/configured-model',
        makeModel('provider/configured-model').pricing,
        configured
      ).completion
    ).toBe('0.000002000000');
  });
});
