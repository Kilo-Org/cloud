import { captureMessage } from '@sentry/nextjs';
import type { OpenRouterModel } from '@/lib/organizations/organization-types';
import type { JustTheCostsUsageStats } from '@/lib/ai-gateway/processUsage.types';
import { QWEN37_MAX_MODEL_ID, QWEN37_PLUS_MODEL_ID } from '@/lib/ai-gateway/providers/qwen';
import {
  calculateCost_mUsd,
  type Pricing,
  type PricingTiers,
} from '@/lib/ai-gateway/providers/kilo-exclusive-model';

export { QWEN37_MAX_MODEL_ID, QWEN37_PLUS_MODEL_ID };

// Qwen long-context pricing starts at exactly 256 Ki tokens (262,144 tokens).
const TOKENS_256K = 256 * 1024;

export type CustomPricing = {
  pricing: PricingTiers;
  /** Human-readable discount shown in the model name; never used in calculations. */
  percentage?: number;
};

export const customPricingByModelId: Record<string, CustomPricing> = {
  [QWEN37_MAX_MODEL_ID]: {
    percentage: 50,
    pricing: [
      {
        start_context_length: 0,
        pricing: {
          prompt_per_million: 1.25,
          completion_per_million: 3.75,
          input_cache_read_per_million: 0.125,
          input_cache_write_per_million: 1.5625,
        },
      },
    ],
  },
  [QWEN37_PLUS_MODEL_ID]: {
    percentage: 20,
    pricing: [
      {
        start_context_length: 0,
        pricing: {
          prompt_per_million: 0.32,
          completion_per_million: 1.28,
          input_cache_read_per_million: 0.032,
          input_cache_write_per_million: 0.4,
        },
      },
      {
        start_context_length: TOKENS_256K,
        pricing: {
          prompt_per_million: 0.96,
          completion_per_million: 3.84,
          input_cache_read_per_million: 0.096,
          input_cache_write_per_million: 1.2,
        },
      },
    ],
  },
};

export function getCustomPricing(modelId: string): CustomPricing | undefined {
  if (!Object.hasOwn(customPricingByModelId, modelId)) return undefined;
  return customPricingByModelId[modelId];
}

function formatPricePerToken(pricePerMillion: number): string {
  return (pricePerMillion / 1_000_000).toFixed(12);
}

function applyPricing(pricing: OpenRouterModel['pricing'], customPricing: Pricing) {
  return {
    ...pricing,
    prompt: formatPricePerToken(customPricing.prompt_per_million),
    completion: formatPricePerToken(customPricing.completion_per_million),
    input_cache_read:
      customPricing.input_cache_read_per_million === null
        ? undefined
        : formatPricePerToken(customPricing.input_cache_read_per_million),
    input_cache_write:
      customPricing.input_cache_write_per_million === null
        ? undefined
        : formatPricePerToken(customPricing.input_cache_write_per_million),
  };
}

export function applyCustomPricingToModel(model: OpenRouterModel): OpenRouterModel {
  const customPricing = getCustomPricing(model.id);
  if (!customPricing) return model;

  const discountSuffix =
    customPricing.percentage === undefined ? '' : ` (${customPricing.percentage}% off)`;

  return {
    ...model,
    name: model.name + discountSuffix,
    pricing: applyPricing(model.pricing, customPricing.pricing[0].pricing),
  };
}

export function calculateCustomCost_mUsd(
  modelId: string,
  usage: JustTheCostsUsageStats
): number | undefined {
  const customPricing = getCustomPricing(modelId);
  if (!customPricing) return undefined;

  const uncachedInputTokens = usage.inputTokens - usage.cacheHitTokens - usage.cacheWriteTokens;
  if (uncachedInputTokens < 0) {
    captureMessage('SUSPICIOUS: negative uncached input tokens for custom pricing', {
      level: 'error',
      tags: { source: 'usage_processing' },
      extra: { model: modelId, usage },
    });
  }

  return Math.round(
    calculateCost_mUsd(
      {
        uncachedInputTokens: Math.max(0, uncachedInputTokens),
        totalOutputTokens: usage.outputTokens,
        cacheHitTokens: usage.cacheHitTokens,
        cacheWriteTokens: usage.cacheWriteTokens,
      },
      customPricing.pricing
    )
  );
}
