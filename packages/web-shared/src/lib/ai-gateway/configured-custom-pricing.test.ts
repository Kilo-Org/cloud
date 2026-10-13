import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import { cleanupDbForTest, db } from '@kilocode/web-shared/lib/drizzle';
import { ai_gateway_config } from '@kilocode/db/schema';
import { GEMINI_FLASH_CURRENT_MODEL_ID } from '@kilocode/web-shared/lib/ai-gateway/providers/google';
import {
  customPricingByModelId,
  getCustomPricing,
  resolveCustomPricing,
  setLoadedConfiguredCustomPricing,
} from '@kilocode/web-shared/lib/ai-gateway/custom-pricing.constants';
import {
  calculateCustomCost_mUsd,
  applyCustomPricingToModel,
} from '@kilocode/web-shared/lib/ai-gateway/custom-pricing';
import {
  loadConfiguredCustomPricing,
  readConfiguredCustomPricing,
} from '@kilocode/web-shared/lib/ai-gateway/configured-custom-pricing';

const configuredPricing = {
  prompt_per_million: 0.5,
  completion_per_million: 2,
  input_cache_read_per_million: 0.05,
  input_cache_write_per_million: null,
};

beforeEach(async () => {
  await cleanupDbForTest();
});

afterEach(() => {
  setLoadedConfiguredCustomPricing({});
});

describe('resolveCustomPricing', () => {
  test('falls back to built-in pricing', () => {
    expect(resolveCustomPricing(GEMINI_FLASH_CURRENT_MODEL_ID, {})).toBe(
      customPricingByModelId[GEMINI_FLASH_CURRENT_MODEL_ID]
    );
    expect(resolveCustomPricing('provider/unpriced', {})).toBeUndefined();
  });

  test('prefers configured pricing over built-in pricing', () => {
    const configured = {
      pricing: [{ start_context_length: 0, pricing: configuredPricing }],
    } as const;
    expect(
      resolveCustomPricing(GEMINI_FLASH_CURRENT_MODEL_ID, {
        [GEMINI_FLASH_CURRENT_MODEL_ID]: configured,
      })
    ).toBe(configured);
  });

  test('ignores inherited object keys', () => {
    expect(resolveCustomPricing('constructor', {})).toBeUndefined();
  });
});

describe('readConfiguredCustomPricing', () => {
  test('returns no pricing when none is stored', async () => {
    await expect(readConfiguredCustomPricing()).resolves.toEqual({});
  });

  test('converts stored pricing into a single tier from context length 0', async () => {
    await db.insert(ai_gateway_config).values({
      custom_pricing: {
        models: [
          {
            model: 'provider/model-a',
            pricing: configuredPricing,
            discountPercentage: 20,
            fallbackOnly: false,
          },
          { model: 'provider/model-b', pricing: configuredPricing, fallbackOnly: true },
        ],
      },
    });

    await expect(readConfiguredCustomPricing()).resolves.toEqual({
      'provider/model-a': {
        pricing: [{ start_context_length: 0, pricing: configuredPricing }],
        discountPercentage: 20,
        fallbackOnly: false,
      },
      'provider/model-b': {
        pricing: [{ start_context_length: 0, pricing: configuredPricing }],
        discountPercentage: undefined,
        fallbackOnly: true,
      },
    });
  });

  test('rejects invalid stored pricing', async () => {
    await db.insert(ai_gateway_config).values({
      custom_pricing: {
        models: [
          {
            model: 'provider/model-a',
            pricing: { ...configuredPricing, prompt_per_million: -1 },
            fallbackOnly: false,
          },
        ],
      },
    });

    await expect(readConfiguredCustomPricing()).rejects.toThrow();
  });
});

describe('loadConfiguredCustomPricing', () => {
  test('makes configured pricing visible to synchronous lookups', async () => {
    await db.insert(ai_gateway_config).values({
      custom_pricing: {
        models: [
          {
            model: 'provider/model-a',
            pricing: configuredPricing,
            discountPercentage: 20,
            fallbackOnly: false,
          },
        ],
      },
    });
    expect(getCustomPricing('provider/model-a')).toBeUndefined();

    await loadConfiguredCustomPricing();

    expect(getCustomPricing('provider/model-a')?.discountPercentage).toBe(20);
    expect(
      calculateCustomCost_mUsd('provider/model-a', {
        cost_mUsd: 999,
        inputTokens: 1_000,
        outputTokens: 100,
        cacheHitTokens: 200,
        cacheWriteTokens: 0,
        is_byok: false,
      })
    ).toBe(Math.round(800 * 0.5 + 100 * 2 + 200 * 0.05));
    expect(
      applyCustomPricingToModel({
        id: 'provider/model-a',
        name: 'Model A',
        created: 0,
        description: 'Model A',
        architecture: {
          input_modalities: ['text'],
          output_modalities: ['text'],
          tokenizer: 'Other',
        },
        top_provider: { is_moderated: false },
        pricing: { prompt: '999', completion: '999' },
        context_length: 1_000_000,
      }).name
    ).toBe('Model A (20% off)');
  });
});
