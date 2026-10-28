import { captureMessage } from '@sentry/nextjs';
import type { CustomPricing, CustomPricingConfig } from '@kilocode/db/schema-types';
import type { OpenRouterModel } from '@kilocode/web-shared/lib/organizations/organization-types';
import type { JustTheCostsUsageStats } from '@kilocode/web-shared/lib/ai-gateway/processUsage.types';
import {
  formatPricePerToken,
  getCustomPricing,
} from '@kilocode/web-shared/lib/ai-gateway/custom-pricing.constants';

type PricingTiers = CustomPricing['pricing'];
type Pricing = PricingTiers[number]['pricing'];

type Usage = {
  uncachedInputTokens: number;
  totalOutputTokens: number;
  cacheWriteTokens: number;
  cacheHitTokens: number;
};

function calculateCost_mUsd(usage: Usage, pricingTiers: PricingTiers): number {
  if (pricingTiers[0].start_context_length !== 0) {
    throw new Error('The first pricing tier must start at context length 0');
  }

  const totalInputTokens =
    usage.uncachedInputTokens + usage.cacheWriteTokens + usage.cacheHitTokens;
  let selectedTier = pricingTiers[0];
  let previousTier = pricingTiers[0];
  for (const tier of pricingTiers.slice(1)) {
    if (tier.start_context_length <= previousTier.start_context_length) {
      throw new Error('Pricing tiers must be ordered by ascending start context length');
    }
    if (tier.start_context_length <= totalInputTokens) {
      selectedTier = tier;
    }
    previousTier = tier;
  }

  const pricing = selectedTier.pricing;
  return (
    usage.uncachedInputTokens * pricing.prompt_per_million +
    usage.cacheWriteTokens * (pricing.input_cache_write_per_million ?? pricing.prompt_per_million) +
    usage.cacheHitTokens * (pricing.input_cache_read_per_million ?? pricing.prompt_per_million) +
    usage.totalOutputTokens * pricing.completion_per_million
  );
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
  config: CustomPricingConfig,
  modelId: string,
  pricing: OpenRouterModel['pricing']
): OpenRouterModel['pricing'] {
  const customPricing = getCustomPricing(config, modelId);
  return customPricing && !customPricing.fallbackOnly
    ? applyPricing(pricing, customPricing.pricing[0].pricing)
    : pricing;
}

export function applyCustomPricingToModel(
  config: CustomPricingConfig,
  model: OpenRouterModel
): OpenRouterModel {
  const customPricing = getCustomPricing(config, model.id);
  if (!customPricing || customPricing.fallbackOnly) return model;

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
  config: CustomPricingConfig,
  modelId: string,
  usage: JustTheCostsUsageStats
): number | undefined {
  const customPricing = getCustomPricing(config, modelId);
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
