import { captureMessage } from '@sentry/nextjs';
import type { OpenRouterModel } from '@/lib/organizations/organization-types';
import type { JustTheCostsUsageStats } from '@/lib/ai-gateway/processUsage.types';
import { GEMINI_FLASH_CURRENT_MODEL_ID } from '@/lib/ai-gateway/providers/google';
import {
  calculateCost_mUsd,
  type Pricing,
  type PricingTiers,
} from '@/lib/ai-gateway/providers/kilo-exclusive-model';

export type CustomPricing = {
  pricing: PricingTiers;
  /** Human-readable discount shown in the model name; never used in calculations. */
  discountPercentage?: number;
  /** Only use this pricing when the upstream response does not report a market cost. */
  fallbackOnly?: boolean;
};

export const customPricingByModelId: Record<string, CustomPricing> = {
  // Google's 50% promotional discount is available through the end of 2026.
  [GEMINI_FLASH_CURRENT_MODEL_ID]: {
    discountPercentage: 50,
    pricing: [
      {
        start_context_length: 0,
        pricing: {
          prompt_per_million: 0.75,
          completion_per_million: 3.75,
          input_cache_read_per_million: 0.075,
          input_cache_write_per_million: 0.0416666666667,
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

export function applyCustomPricingToPricing(
  modelId: string,
  pricing: OpenRouterModel['pricing']
): OpenRouterModel['pricing'] {
  const customPricing = getCustomPricing(modelId);
  return customPricing && !customPricing.fallbackOnly
    ? applyPricing(pricing, customPricing.pricing[0].pricing)
    : pricing;
}

export function applyCustomPricingToModel(model: OpenRouterModel): OpenRouterModel {
  const customPricing = getCustomPricing(model.id);
  if (!customPricing) return model;

  const discountSuffix =
    customPricing.discountPercentage === undefined
      ? ''
      : ` (${customPricing.discountPercentage}% off)`;

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
  if (!customPricing || (customPricing.fallbackOnly && usage.cost_mUsd > 0)) return undefined;

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
