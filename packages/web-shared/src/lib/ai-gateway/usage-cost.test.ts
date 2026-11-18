import { describe, expect, test } from '@jest/globals';
import type {
  CustomPricing,
  CustomPricingConfig,
  CustomPricingTiers,
} from '@kilocode/db/schema-types';
import { TEST_CUSTOM_PRICING_CONFIG } from '@kilocode/web-shared/tests/helpers/custom-pricing.helper';
import type { JustTheCostsUsageStats } from '@kilocode/web-shared/lib/ai-gateway/processUsage.types';
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
  custom_llm_pricing: null,
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
      makeContext({ requested_model: 'google/gemini-3.8-flash' }),
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
      makeContext({ requested_model: 'google/gemini-3.8-flash' }),
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
    { label: 'Claude organization', context: makeContext({ provider: 'claude-billing' }) },
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

  describe('custom LLM pricing', () => {
    const customLlmPricing: CustomPricingTiers = [
      {
        start_context_length: 0,
        pricing: {
          prompt_per_million: 2,
          completion_per_million: 8,
          input_cache_read_per_million: 0.5,
          input_cache_write_per_million: null,
        },
      },
      {
        start_context_length: 200_000,
        pricing: {
          prompt_per_million: 4,
          completion_per_million: 16,
          input_cache_read_per_million: 1,
          input_cache_write_per_million: null,
        },
      },
    ];

    test('bills the tier reached by the input tokens instead of the upstream cost', () => {
      const usage = makeUsage({
        cost_mUsd: 700,
        inputTokens: 100_000,
        cacheHitTokens: 40_000,
        cacheWriteTokens: 10_000,
        outputTokens: 10_000,
      });

      applyUsagePricing(
        usage,
        makeContext({ provider: 'custom', custom_llm_pricing: customLlmPricing }),
        TEST_CUSTOM_PRICING_CONFIG
      );

      expect(usage.cost_mUsd).toBe(50_000 * 2 + 10_000 * 2 + 40_000 * 0.5 + 10_000 * 8);
      expect(usage.market_cost).toBe(700);
    });

    test('bills a later tier once the input reaches its start', () => {
      const usage = makeUsage({ cost_mUsd: 0, inputTokens: 250_000, outputTokens: 1000 });

      applyUsagePricing(
        usage,
        makeContext({ provider: 'custom', custom_llm_pricing: customLlmPricing }),
        TEST_CUSTOM_PRICING_CONFIG
      );

      expect(usage.cost_mUsd).toBe(250_000 * 4 + 1000 * 16);
    });

    test('takes precedence over a custom pricing entry for the same model', () => {
      const usage = makeUsage({ inputTokens: 1_000_000, outputTokens: 0 });

      applyUsagePricing(
        usage,
        makeContext({
          requested_model: 'google/gemini-3.8-flash',
          provider: 'custom',
          custom_llm_pricing: customLlmPricing,
        }),
        TEST_CUSTOM_PRICING_CONFIG
      );

      expect(usage.cost_mUsd).toBe(4_000_000);
    });
  });

  test('zeroes free custom-priced usage without replacing its upstream market cost', () => {
    const usage = makeUsage({ cacheDiscount_mUsd: 12_345 });

    applyUsagePricing(
      usage,
      makeContext({ requested_model: 'google/gemini-3.8-flash', is_free: true }),
      TEST_CUSTOM_PRICING_CONFIG
    );

    expect(usage.cost_mUsd).toBe(0);
    expect(usage.cacheDiscount_mUsd).toBe(0);
    expect(usage.market_cost).toBe(900_000);
  });
});
