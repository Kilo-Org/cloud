import { describe, expect, test } from '@jest/globals';
import type { CustomPricing, CustomPricingConfig } from '@kilocode/db/schema-types';
import { TEST_CUSTOM_PRICING_CONFIG } from '@kilocode/web-shared/tests/helpers/custom-pricing.helper';
import type { JustTheCostsUsageStats } from '@kilocode/web-shared/lib/ai-gateway/processUsage.types';
import { GEMINI_FLASH_CURRENT_MODEL_ID } from '@kilocode/web-shared/lib/ai-gateway/providers/google';
import { applyUsagePricing } from '@kilocode/web-shared/lib/ai-gateway/usage-cost';

const makeUsage = (overrides: Partial<JustTheCostsUsageStats> = {}): JustTheCostsUsageStats => ({
  cost_mUsd: 900_000,
  inputTokens: 100_000,
  outputTokens: 10_000,
  cacheWriteTokens: 0,
  cacheHitTokens: 0,
  is_byok: false,
  ...overrides,
});

const makeContext = (
  overrides: Partial<Parameters<typeof applyUsagePricing>[1]> = {}
): Parameters<typeof applyUsagePricing>[1] => ({
  requested_model: 'openai/gpt-4.1',
  provider: 'openrouter',
  is_free: false,
  user_byok: false,
  ...overrides,
});

function fallbackOnlyCustomPricingFor(model: string): CustomPricingConfig {
  return { models: [{ ...fallbackOnlyCustomPricing, model }] };
}

const fallbackOnlyCustomPricing: CustomPricing = {
  model: 'openai/gpt-4.1',
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
  ],
  fallbackOnly: true,
};

describe('applyUsagePricing', () => {
  test('preserves paid upstream cost and cache discount while recording market cost', () => {
    const usage = makeUsage({ cacheDiscount_mUsd: 12_345 });

    applyUsagePricing(usage, makeContext(), TEST_CUSTOM_PRICING_CONFIG);

    expect(usage).toEqual(makeUsage({ market_cost: 900_000, cacheDiscount_mUsd: 12_345 }));
  });

  test('preserves an existing market cost when upstream pricing is unchanged', () => {
    const usage = makeUsage({ market_cost: 1_200_000 });

    applyUsagePricing(usage, makeContext(), TEST_CUSTOM_PRICING_CONFIG);

    expect(usage.market_cost).toBe(1_200_000);
    expect(usage.cost_mUsd).toBe(900_000);
  });

  test('does not treat upstream system BYOK as user BYOK', () => {
    const usage = makeUsage({ is_byok: true, cacheDiscount_mUsd: 12_345 });

    applyUsagePricing(usage, makeContext(), TEST_CUSTOM_PRICING_CONFIG);

    expect(usage.cost_mUsd).toBe(900_000);
    expect(usage.cacheDiscount_mUsd).toBe(12_345);
  });

  test('applies custom cache pricing and rounds to whole microdollars without changing the discount', () => {
    const usage = makeUsage({
      inputTokens: 1_000_000,
      outputTokens: 500_000,
      cacheHitTokens: 200_000,
      cacheWriteTokens: 100_000,
      cacheDiscount_mUsd: 12_345,
    });

    applyUsagePricing(
      usage,
      makeContext({ requested_model: GEMINI_FLASH_CURRENT_MODEL_ID }),
      TEST_CUSTOM_PRICING_CONFIG
    );

    expect(usage.cost_mUsd).toBe(2_419_167);
    expect(usage.market_cost).toBe(900_000);
    expect(usage.cacheDiscount_mUsd).toBe(12_345);
  });

  test.each([
    { upstreamCost: 123_000, expected: 123_000 },
    { upstreamCost: 0, expected: 120_000 },
  ])(
    'respects custom fallback-only pricing for upstream cost $upstreamCost',
    ({ upstreamCost, expected }) => {
      const usage = makeUsage({ cost_mUsd: upstreamCost });

      applyUsagePricing(usage, makeContext(), fallbackOnlyCustomPricingFor('openai/gpt-4.1'));

      expect(usage.cost_mUsd).toBe(expected);
      expect(usage.market_cost).toBe(upstreamCost);
    }
  );

  test('charges BYOK non-inference costs on top of custom pricing', () => {
    const usage = makeUsage({ cost_mUsd: 907_000, nonInferenceCost_mUsd: 7000 });

    applyUsagePricing(
      usage,
      makeContext({ requested_model: GEMINI_FLASH_CURRENT_MODEL_ID }),
      TEST_CUSTOM_PRICING_CONFIG
    );

    expect(usage.cost_mUsd).toBe(112_500 + 7000);
    expect(usage.market_cost).toBe(907_000);
  });

  test('applies fallback-only pricing when only non-inference costs were reported', () => {
    const usage = makeUsage({ cost_mUsd: 7000, nonInferenceCost_mUsd: 7000 });

    applyUsagePricing(usage, makeContext(), fallbackOnlyCustomPricingFor('openai/gpt-4.1'));

    expect(usage.cost_mUsd).toBe(120_000 + 7000);
  });

  test.each([
    { label: 'free', context: makeContext({ is_free: true }) },
    { label: 'user BYOK', context: makeContext({ user_byok: true }) },
    { label: 'ChatGPT', context: makeContext({ provider: 'openai-chatgpt' }) },
  ])(
    'zeroes billed cost and cache discount for $label while preserving market cost',
    ({ context }) => {
      const usage = makeUsage({ cacheDiscount_mUsd: 12_345 });

      applyUsagePricing(usage, context, TEST_CUSTOM_PRICING_CONFIG);

      expect(usage.cost_mUsd).toBe(0);
      expect(usage.cacheDiscount_mUsd).toBe(0);
      expect(usage.market_cost).toBe(900_000);
    }
  );

  test('zeroes free custom-priced usage without replacing its upstream market cost', () => {
    const usage = makeUsage({ cacheDiscount_mUsd: 12_345 });

    applyUsagePricing(
      usage,
      makeContext({ requested_model: GEMINI_FLASH_CURRENT_MODEL_ID, is_free: true }),
      TEST_CUSTOM_PRICING_CONFIG
    );

    expect(usage.cost_mUsd).toBe(0);
    expect(usage.cacheDiscount_mUsd).toBe(0);
    expect(usage.market_cost).toBe(900_000);
  });
});
