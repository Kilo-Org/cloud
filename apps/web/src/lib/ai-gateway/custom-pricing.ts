import type { OpenRouterModel } from '@/lib/organizations/organization-types';

export const QWEN37_MAX_MODEL_ID = 'qwen/qwen3.7-max';
export const QWEN37_PLUS_MODEL_ID = 'qwen/qwen3.7-plus';

export type CustomPricing = {
  multiplier: number;
  percentage?: number;
};

export const customPricingByModelId: Record<string, CustomPricing> = {
  [QWEN37_MAX_MODEL_ID]: {
    multiplier: 0.5,
    percentage: 50,
  },
  [QWEN37_PLUS_MODEL_ID]: {
    multiplier: 0.8,
    percentage: 20,
  },
};

export function getCustomPricing(modelId: string): CustomPricing | undefined {
  if (!Object.hasOwn(customPricingByModelId, modelId)) return undefined;
  return customPricingByModelId[modelId];
}

export function applyCustomPricingToModel(model: OpenRouterModel): OpenRouterModel {
  const customPricing = getCustomPricing(model.id);
  if (!customPricing) return model;

  const pricing = { ...model.pricing };
  for (const key of Object.keys(pricing) as (keyof typeof pricing)[]) {
    const value = pricing[key];
    if (value !== undefined) {
      const parsedPrice = Number.parseFloat(value);
      if (Number.isFinite(parsedPrice)) {
        pricing[key] = (parsedPrice * customPricing.multiplier).toFixed(12);
      }
    }
  }

  const discountSuffix =
    customPricing.percentage === undefined ? '' : ` (${customPricing.percentage}% off)`;

  return {
    ...model,
    name: model.name + discountSuffix,
    pricing,
  };
}

export function applyCustomPricingToCost_mUsd(modelId: string, marketCost_mUsd: number): number {
  const customPricing = getCustomPricing(modelId);
  if (!customPricing) return marketCost_mUsd;
  return Math.round(marketCost_mUsd * customPricing.multiplier);
}
