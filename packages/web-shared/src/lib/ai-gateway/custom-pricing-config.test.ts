import { beforeEach, describe, expect, test } from '@jest/globals';
import { cleanupDbForTest, db } from '@kilocode/web-shared/lib/drizzle';
import { ai_gateway_config } from '@kilocode/db/schema';
import {
  CustomPricingConfigSchema,
  CustomPricingConfigWriteSchema,
  type CustomPricing,
  type CustomPricingConfig,
} from '@kilocode/db/schema-types';
import { EMPTY_CUSTOM_PRICING_CONFIG } from '@kilocode/web-shared/lib/ai-gateway/custom-pricing.constants';
import { TEST_CUSTOM_PRICING_CONFIG } from '@kilocode/web-shared/tests/helpers/custom-pricing.helper';
import {
  getCustomPricingConfig,
  readCustomPricingConfig,
  resolveCustomPricingAliases,
} from '@kilocode/web-shared/lib/ai-gateway/custom-pricing-config';
import type { GatewayModelMap } from '@kilocode/web-shared/lib/ai-gateway/providers/gateway-model-metadata';
import { getOpenRouterModelsMetadataFromDatabase } from '@kilocode/web-shared/lib/ai-gateway/providers/gateway-models-cache';
import { applyUsagePricing } from '@kilocode/web-shared/lib/ai-gateway/usage-cost';

jest.mock('@kilocode/web-shared/lib/ai-gateway/providers/gateway-models-cache', () => ({
  getOpenRouterModelsMetadataFromDatabase: jest.fn(),
}));

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

  test('returns no custom pricing when no config row exists', async () => {
    expect(await readCustomPricingConfig()).toBe(EMPTY_CUSTOM_PRICING_CONFIG);
  });

  test('returns no custom pricing when the column is null', async () => {
    await db.insert(ai_gateway_config).values({ preferred_models: { models: ['provider/a'] } });
    expect(await readCustomPricingConfig()).toBe(EMPTY_CUSTOM_PRICING_CONFIG);
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
  test('accepts the test fixture', () => {
    expect(CustomPricingConfigSchema.parse(TEST_CUSTOM_PRICING_CONFIG)).toEqual(
      TEST_CUSTOM_PRICING_CONFIG
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

const alias = '~vendor/family-latest';
const target = 'vendor/family-0101';
const targetEntry: CustomPricing = {
  model: target,
  discountPercentage: 50,
  pricing: [tier(0), tier(200_000)],
};

function metadata(aliasTarget?: string): GatewayModelMap {
  return {
    [alias]: {
      id: alias,
      name: 'Vendor: Family Latest',
      endpoints: [],
      ...(aliasTarget && { alias_target: { slug: aliasTarget } }),
    },
    [target]: { id: target, name: 'Vendor: Family', endpoints: [] },
  };
}

describe('resolveCustomPricingAliases', () => {
  test("prices a latest alias as its target, keeping the target's other settings", () => {
    expect(resolveCustomPricingAliases({ models: [targetEntry] }, metadata(target))).toEqual({
      models: [targetEntry, { ...targetEntry, model: alias }],
    });
  });

  test("ignores an entry for the alias itself in favor of the target's", () => {
    const aliasEntry: CustomPricing = {
      model: alias,
      pricing: [{ ...tier(0), pricing: { ...tier(0).pricing, prompt_per_million: 9 } }],
    };
    expect(
      resolveCustomPricingAliases({ models: [aliasEntry, targetEntry] }, metadata(target))
    ).toEqual({ models: [targetEntry, { ...targetEntry, model: alias }] });
  });

  test.each([
    ['does not resolve', metadata()],
    ['is missing from the metadata', {}],
  ])('gives no custom pricing to an alias that %s', (_label, models) => {
    const aliasEntry: CustomPricing = { model: alias, pricing: [tier(0)] };
    expect(resolveCustomPricingAliases({ models: [aliasEntry, targetEntry] }, models)).toEqual({
      models: [targetEntry],
    });
  });

  test('adds nothing for an alias whose target has no custom pricing', () => {
    const other: CustomPricing = { model: 'vendor/other', pricing: [tier(0)] };
    expect(resolveCustomPricingAliases({ models: [other] }, metadata(target))).toEqual({
      models: [other],
    });
  });
});

describe('getCustomPricingConfig', () => {
  beforeEach(async () => {
    await cleanupDbForTest();
  });

  test("bills a latest alias request at its target's custom pricing", async () => {
    await db.insert(ai_gateway_config).values({ custom_pricing: { models: [targetEntry] } });
    jest.mocked(getOpenRouterModelsMetadataFromDatabase).mockResolvedValue(metadata(target));
    const usage = {
      cost_mUsd: 900_000,
      inputTokens: 1_000_000,
      outputTokens: 100_000,
      cacheWriteTokens: 0,
      cacheHitTokens: 0,
      is_byok: false,
    };
    const context = {
      provider: 'openrouter',
      is_free: false,
      user_byok: false,
      custom_llm_pricing: null,
    } as const;
    const config = await getCustomPricingConfig();
    const aliasUsage = { ...usage };
    const targetUsage = { ...usage };

    applyUsagePricing(aliasUsage, { ...context, requested_model: alias }, config);
    applyUsagePricing(targetUsage, { ...context, requested_model: target }, config);

    expect(aliasUsage.cost_mUsd).toBe(1_000_000 * 1 + 100_000 * 2);
    expect(aliasUsage).toEqual(targetUsage);
  });
});

describe('CustomPricingConfigWriteSchema', () => {
  const aliasConfig: CustomPricingConfig = { models: [{ model: alias, pricing: [tier(0)] }] };

  test('refuses an entry for a latest alias with an error naming it', () => {
    const result = CustomPricingConfigWriteSchema.safeParse(aliasConfig);
    expect(result.success).toBe(false);
    expect(result.error?.issues).toEqual([
      expect.objectContaining({
        path: ['models', 0, 'model'],
        message: expect.stringContaining(`"${alias}" is a latest alias`),
      }),
    ]);
  });

  test('accepts a config without aliases', () => {
    expect(CustomPricingConfigWriteSchema.parse(TEST_CUSTOM_PRICING_CONFIG)).toEqual(
      TEST_CUSTOM_PRICING_CONFIG
    );
  });

  test('leaves a stored config with an alias entry readable', async () => {
    await cleanupDbForTest();
    await db.insert(ai_gateway_config).values({ custom_pricing: aliasConfig });
    expect(await readCustomPricingConfig()).toEqual(aliasConfig);
  });
});
