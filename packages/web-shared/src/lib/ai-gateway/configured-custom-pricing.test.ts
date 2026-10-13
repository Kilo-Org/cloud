import { beforeEach, describe, expect, test } from '@jest/globals';
import { cleanupDbForTest, db } from '@kilocode/web-shared/lib/drizzle';
import { ai_gateway_config } from '@kilocode/db/schema';
import { GEMINI_FLASH_CURRENT_MODEL_ID } from '@kilocode/web-shared/lib/ai-gateway/providers/google';
import {
  customPricingByModelId,
  getCustomPricing,
} from '@kilocode/web-shared/lib/ai-gateway/custom-pricing.constants';
import { calculateCustomCost_mUsd } from '@kilocode/web-shared/lib/ai-gateway/custom-pricing';
import {
  getConfiguredCustomPricing,
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

describe('getCustomPricing', () => {
  test('falls back to built-in pricing', () => {
    expect(getCustomPricing(GEMINI_FLASH_CURRENT_MODEL_ID, {})).toBe(
      customPricingByModelId[GEMINI_FLASH_CURRENT_MODEL_ID]
    );
    expect(getCustomPricing('provider/unpriced', {})).toBeUndefined();
  });

  test('prefers configured pricing over built-in pricing', () => {
    const configured = {
      pricing: [{ start_context_length: 0, pricing: configuredPricing }],
    } as const;
    expect(
      getCustomPricing(GEMINI_FLASH_CURRENT_MODEL_ID, {
        [GEMINI_FLASH_CURRENT_MODEL_ID]: configured,
      })
    ).toBe(configured);
  });

  test('ignores inherited object keys', () => {
    expect(getCustomPricing('constructor', {})).toBeUndefined();
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

describe('getConfiguredCustomPricing', () => {
  test('bills stored pricing and keeps built-in pricing as the fallback', async () => {
    await db.insert(ai_gateway_config).values({
      custom_pricing: {
        models: [{ model: 'provider/model-a', pricing: configuredPricing, fallbackOnly: false }],
      },
    });
    const usage = {
      cost_mUsd: 999,
      inputTokens: 1_000,
      outputTokens: 100,
      cacheHitTokens: 200,
      cacheWriteTokens: 0,
      is_byok: false,
    };

    const configured = await getConfiguredCustomPricing();

    expect(calculateCustomCost_mUsd('provider/model-a', usage, configured)).toBe(
      Math.round(800 * 0.5 + 100 * 2 + 200 * 0.05)
    );
    expect(calculateCustomCost_mUsd(GEMINI_FLASH_CURRENT_MODEL_ID, usage, configured)).toBe(
      Math.round(800 * 0.75 + 100 * 3.75 + 200 * 0.075)
    );
  });
});
