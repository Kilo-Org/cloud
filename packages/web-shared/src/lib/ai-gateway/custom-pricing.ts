import { captureMessage } from '@sentry/nextjs';
import type { OpenRouterModel } from '@kilocode/web-shared/lib/organizations/organization-types';
import type { JustTheCostsUsageStats } from '@kilocode/web-shared/lib/ai-gateway/processUsage.types';
import {
  calculateCost_mUsd,
  type Pricing,
} from '@kilocode/web-shared/lib/ai-gateway/providers/kilo-exclusive-model';
import {
  formatPricePerToken,
  getCustomPricing,
} from '@kilocode/web-shared/lib/ai-gateway/custom-pricing.constants';

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
