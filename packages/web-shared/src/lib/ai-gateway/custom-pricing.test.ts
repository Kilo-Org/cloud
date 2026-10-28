import { describe, expect, test } from '@jest/globals';
import { captureMessage } from '@sentry/nextjs';
import type { CustomPricingConfig } from '@kilocode/db/schema-types';
import type { OpenRouterModel } from '@kilocode/web-shared/lib/organizations/organization-types';
import { GEMINI_4_ARGON_MODEL_ID } from '@kilocode/web-shared/lib/ai-gateway/providers/google';
import {
  applyCustomPricingToPricing,
  applyCustomPricingToModel,
  calculateCustomCost_mUsd,
} from './custom-pricing';
import { TEST_CUSTOM_PRICING_CONFIG } from '@kilocode/web-shared/tests/helpers/custom-pricing.helper';

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

const makeUsage = (overrides: Partial<Parameters<typeof calculateCustomCost_mUsd>[2]> = {}) => ({
  cost_mUsd: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheWriteTokens: 0,
  cacheHitTokens: 0,
  is_byok: false,
  ...overrides,
});

const config = TEST_CUSTOM_PRICING_CONFIG;

describe('custom model pricing', () => {
  test('replaces upstream Gemini 3.8 Flash pricing with the promotional rates', () => {
    const model = applyCustomPricingToModel(config, {
      ...makeModel('google/gemini-3.8-flash'),
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
        config,
        'google/gemini-3.8-flash',
        makeUsage({ inputTokens: 100, cost_mUsd: 999 })
      )
    ).toBe(Math.round(100 * 0.75));
  });

  test('replaces upstream Gemini 4 Argon pricing with the promotional rates', () => {
    const model = applyCustomPricingToModel(config, {
      ...makeModel(GEMINI_4_ARGON_MODEL_ID),
      name: 'Google: Gemini 4 Argon',
    });

    expect(model.name).toBe('Google: Gemini 4 Argon (50% off)');
    expect(model.pricing).toEqual({
      prompt: '0.000002000000',
      completion: '0.000010000000',
      input_cache_read: '0.000000100000',
      input_cache_write: '0.000000187500',
    });
    expect(
      calculateCustomCost_mUsd(
        config,
        GEMINI_4_ARGON_MODEL_ID,
        makeUsage({
          inputTokens: 1_000,
          outputTokens: 100,
          cacheHitTokens: 200,
          cacheWriteTokens: 300,
          cost_mUsd: 999,
        })
      )
    ).toBe(Math.round(500 * 2 + 100 * 10 + 200 * 0.1 + 300 * 0.1875));
  });

  test.each(['qwen/qwen3.7-max', 'qwen/qwen3.7-plus', 'mistralai/mistral-large-4-0'])(
    'does not apply custom pricing to %s',
    modelId => {
      const model = makeModel(modelId);

      expect(applyCustomPricingToModel(config, model)).toBe(model);
      expect(applyCustomPricingToPricing(config, model.id, model.pricing)).toBe(model.pricing);
      expect(calculateCustomCost_mUsd(config, model.id, makeUsage())).toBeUndefined();
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

      expect(applyCustomPricingToModel(config, model)).toBe(model);
      expect(applyCustomPricingToPricing(config, model.id, model.pricing)).toBe(model.pricing);
      expect(calculateCustomCost_mUsd(config, model.id, usage)).toBeUndefined();
      expect(
        calculateCustomCost_mUsd(config, model.id, { ...usage, cost_mUsd: 123 })
      ).toBeUndefined();
    }
  );

  test('reports invalid negative uncached token counts', () => {
    const captureMessageMock = jest.mocked(captureMessage);
    captureMessageMock.mockClear();

    const cost_mUsd = calculateCustomCost_mUsd(
      config,
      'google/gemini-3.8-flash',
      makeUsage({ inputTokens: 10, cacheHitTokens: 20 })
    );

    expect(cost_mUsd).toBe(Math.round(20 * 0.075));
    expect(captureMessageMock).toHaveBeenCalledWith(
      'SUSPICIOUS: negative uncached input tokens for custom pricing',
      expect.objectContaining({
        level: 'error',
        extra: expect.objectContaining({ model: 'google/gemini-3.8-flash' }),
      })
    );
  });

  test('leaves models without custom pricing unchanged', () => {
    const model = makeModel('qwen/another-model');

    expect(applyCustomPricingToModel(config, model)).toBe(model);
    expect(calculateCustomCost_mUsd(config, model.id, makeUsage())).toBeUndefined();
  });

  test('applies a configured entry and its context-length tiers', () => {
    const tieredConfig: CustomPricingConfig = {
      models: [
        {
          model: 'qwen/qwen3.7-max',
          fallbackOnly: true,
          pricing: [
            {
              start_context_length: 0,
              pricing: {
                prompt_per_million: 1,
                completion_per_million: 2,
                input_cache_read_per_million: null,
                input_cache_write_per_million: null,
              },
            },
            {
              start_context_length: 1_000,
              pricing: {
                prompt_per_million: 10,
                completion_per_million: 20,
                input_cache_read_per_million: null,
                input_cache_write_per_million: null,
              },
            },
          ],
        },
      ],
    };
    const model = makeModel('qwen/qwen3.7-max');

    expect(applyCustomPricingToPricing(tieredConfig, model.id, model.pricing)).toBe(model.pricing);
    expect(applyCustomPricingToModel(tieredConfig, model)).toBe(model);
    expect(
      calculateCustomCost_mUsd(tieredConfig, model.id, makeUsage({ cost_mUsd: 5 }))
    ).toBeUndefined();
    expect(calculateCustomCost_mUsd(tieredConfig, model.id, makeUsage({ inputTokens: 999 }))).toBe(
      999
    );
    expect(
      calculateCustomCost_mUsd(
        tieredConfig,
        model.id,
        makeUsage({ inputTokens: 1_000, outputTokens: 10 })
      )
    ).toBe(10_000 + 200);
    expect(
      calculateCustomCost_mUsd(tieredConfig, 'google/gemini-3.8-flash', makeUsage())
    ).toBeUndefined();
  });
});
