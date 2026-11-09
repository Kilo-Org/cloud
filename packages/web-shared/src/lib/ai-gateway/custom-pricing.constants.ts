import type { CustomPricing, CustomPricingConfig } from '@kilocode/db/schema-types';

// Keep this file free of server-only dependencies: the organization Providers &
// Models screen imports it to show the prices Kilo actually bills.

export const EMPTY_CUSTOM_PRICING_CONFIG: CustomPricingConfig = { models: [] };

export function getCustomPricing(
  config: CustomPricingConfig,
  modelId: string
): CustomPricing | undefined {
  return config.models.find(entry => entry.model === modelId);
}

export function formatPricePerToken(pricePerMillion: number): string {
  return (pricePerMillion / 1_000_000).toFixed(12);
}
