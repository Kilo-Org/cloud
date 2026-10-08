import { GEMINI_FLASH_CURRENT_MODEL_ID } from '@kilocode/web-shared/lib/ai-gateway/providers/google';
import { MISTRAL_LARGE_4_MODEL_ID } from '@kilocode/web-shared/lib/ai-gateway/providers/mistral.constants';
import type { PricingTiers } from '@kilocode/web-shared/lib/ai-gateway/providers/kilo-exclusive-model';

// Keep this file free of server-only dependencies: the organization Providers &
// Models screen imports it to show the prices Kilo actually bills.

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
  // OpenRouter lists a 50% discount on Mistral, the only provider for this model.
  [MISTRAL_LARGE_4_MODEL_ID]: {
    discountPercentage: 50,
    pricing: [
      {
        start_context_length: 0,
        pricing: {
          prompt_per_million: 0.68,
          completion_per_million: 2.09,
          input_cache_read_per_million: 0.07,
          input_cache_write_per_million: null,
        },
      },
    ],
  },
};

export function getCustomPricing(modelId: string): CustomPricing | undefined {
  if (!Object.hasOwn(customPricingByModelId, modelId)) return undefined;
  return customPricingByModelId[modelId];
}

export function formatPricePerToken(pricePerMillion: number): string {
  return (pricePerMillion / 1_000_000).toFixed(12);
}
