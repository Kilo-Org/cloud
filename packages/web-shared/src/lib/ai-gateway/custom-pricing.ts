import { captureMessage } from '@sentry/nextjs';
import type { CustomPricingConfig, CustomPricingTiers } from '@kilocode/db/schema-types';
import type { OpenRouterModel } from '@kilocode/web-shared/lib/organizations/organization-types';
import type { JustTheCostsUsageStats } from '@kilocode/web-shared/lib/ai-gateway/processUsage.types';
import {
  formatPricePerToken,
  getCustomPricing,
} from '@kilocode/web-shared/lib/ai-gateway/custom-pricing.constants';
import { claimReportWindow } from '@kilocode/web-shared/lib/ai-gateway/report-window';

type Pricing = CustomPricingTiers[number]['pricing'];

type Usage = {
  uncachedInputTokens: number;
  totalOutputTokens: number;
  cacheWriteTokens: number;
  cacheHitTokens: number;
};

function calculateCost_mUsd(usage: Usage, pricingTiers: CustomPricingTiers): number {
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

/** Model lists show the first tier, the price of a short request. */
export function applyPricingTiers(
  pricing: OpenRouterModel['pricing'],
  pricingTiers: CustomPricingTiers
): OpenRouterModel['pricing'] {
  return applyPricing(pricing, pricingTiers[0].pricing);
}

export function applyCustomPricingToPricing(
  config: CustomPricingConfig,
  modelId: string,
  pricing: OpenRouterModel['pricing']
): OpenRouterModel['pricing'] {
  const customPricing = getCustomPricing(config, modelId);
  return customPricing && !customPricing.fallbackOnly
    ? applyPricingTiers(pricing, customPricing.pricing)
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
    pricing: applyPricingTiers(model.pricing, customPricing.pricing),
  };
}

export function calculateCustomCost_mUsd(
  config: CustomPricingConfig,
  modelId: string,
  usage: JustTheCostsUsageStats
): number | undefined {
  const customPricing = getCustomPricing(config, modelId);
  if (!customPricing || (customPricing.fallbackOnly && usage.cost_mUsd > 0)) return undefined;
  return calculateTieredCost_mUsd(customPricing.pricing, modelId, usage);
}

export function calculateTieredCost_mUsd(
  pricingTiers: CustomPricingTiers,
  modelId: string,
  usage: JustTheCostsUsageStats
): number {
  const uncachedInputTokens = usage.inputTokens - usage.cacheHitTokens - usage.cacheWriteTokens;
  // A model that keeps reporting impossible token counts would otherwise add one Sentry event per
  // usage, so the anomaly reports once per model per window.
  if (
    uncachedInputTokens < 0 &&
    claimReportWindow(`custom-pricing:negative-uncached:${modelId}`, Date.now())
  ) {
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
      pricingTiers
    )
  );
}
