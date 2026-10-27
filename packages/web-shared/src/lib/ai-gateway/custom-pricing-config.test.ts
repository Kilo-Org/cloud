import { beforeEach, describe, expect, test } from '@jest/globals';
import { cleanupDbForTest, db } from '@kilocode/web-shared/lib/drizzle';
import { ai_gateway_config } from '@kilocode/db/schema';
import { CustomPricingConfigSchema, type CustomPricingConfig } from '@kilocode/db/schema-types';
import { CUSTOM_PRICING_FALLBACK_CONFIG } from '@kilocode/web-shared/lib/ai-gateway/custom-pricing.constants';
import { readCustomPricingConfig } from '@kilocode/web-shared/lib/ai-gateway/custom-pricing-config';

const tier = (start_context_length: number) => ({
  start_context_length,
  pricing: {
    prompt_per_million: 1,
    completion_per_million: 2,
    input_cache_read_per_million: 0.1,
    input_cache_write_per_million: null,
  },
});

const config: CustomPricingConfig = {
  models: [{ model: 'vendor/model-a', discountPercentage: 25, pricing: [tier(0), tier(200_000)] }],
};

describe('readCustomPricingConfig', () => {
  beforeEach(async () => {
    await cleanupDbForTest();
  });

  test('returns the in-code fallback when no config row exists', async () => {
    expect(await readCustomPricingConfig()).toBe(CUSTOM_PRICING_FALLBACK_CONFIG);
  });

  test('returns the in-code fallback when the column is null', async () => {
    await db.insert(ai_gateway_config).values({ preferred_models: { models: ['provider/a'] } });
    expect(await readCustomPricingConfig()).toBe(CUSTOM_PRICING_FALLBACK_CONFIG);
  });

  test('reads the stored config', async () => {
    await db.insert(ai_gateway_config).values({ custom_pricing: config });
    expect(await readCustomPricingConfig()).toEqual(config);
  });

  test('reads a stored empty config as no custom pricing', async () => {
    await db.insert(ai_gateway_config).values({ custom_pricing: { models: [] } });
    expect(await readCustomPricingConfig()).toEqual({ models: [] });
  });

  test('throws on an invalid stored config', async () => {
    await db.insert(ai_gateway_config).values({
      custom_pricing: { models: [{ model: 'vendor/model-a', pricing: [tier(5)] }] },
    });
    await expect(readCustomPricingConfig()).rejects.toThrow();
  });
});

describe('CustomPricingConfigSchema', () => {
  test('accepts the in-code fallback', () => {
    expect(CustomPricingConfigSchema.parse(CUSTOM_PRICING_FALLBACK_CONFIG)).toEqual(
      CUSTOM_PRICING_FALLBACK_CONFIG
    );
  });

  test.each([
    ['a first tier that does not start at 0', { models: [{ model: 'a/b', pricing: [tier(1)] }] }],
    [
      'tiers that are not ascending',
      { models: [{ model: 'a/b', pricing: [tier(0), tier(10), tier(10)] }] },
    ],
    [
      'duplicate models',
      {
        models: [
          { model: 'a/b', pricing: [tier(0)] },
          { model: 'a/b', pricing: [tier(0)] },
        ],
      },
    ],
    [
      'a negative price',
      {
        models: [
          {
            model: 'a/b',
            pricing: [{ ...tier(0), pricing: { ...tier(0).pricing, prompt_per_million: -1 } }],
          },
        ],
      },
    ],
    [
      'a discount above 100%',
      { models: [{ model: 'a/b', discountPercentage: 101, pricing: [tier(0)] }] },
    ],
    ['an uppercase model ID', { models: [{ model: 'A/B', pricing: [tier(0)] }] }],
  ])('rejects %s', (_label, value) => {
    expect(CustomPricingConfigSchema.safeParse(value).success).toBe(false);
  });
});
