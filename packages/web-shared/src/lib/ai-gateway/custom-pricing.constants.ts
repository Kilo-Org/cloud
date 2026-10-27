import type { CustomPricing, CustomPricingConfig } from '@kilocode/db/schema-types';
import {
  GEMINI_4_ARGON_MODEL_ID,
  GEMINI_FLASH_CURRENT_MODEL_ID,
} from '@kilocode/web-shared/lib/ai-gateway/providers/google';

// Keep this file free of server-only dependencies: the organization Providers &
// Models screen imports it to show the prices Kilo actually bills.

/** Used when `ai_gateway_config.custom_pricing` is unset or cannot be read. */
export const CUSTOM_PRICING_FALLBACK_CONFIG: CustomPricingConfig = {
  models: [
    // Google's 50% promotional discount is available through the end of 2026.
    {
      model: GEMINI_FLASH_CURRENT_MODEL_ID,
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
    // OpenRouter lists a 50% Google discount on every Gemini 4 Argon endpoint.
    {
      model: GEMINI_4_ARGON_MODEL_ID,
      discountPercentage: 50,
      pricing: [
        {
          start_context_length: 0,
          pricing: {
            prompt_per_million: 2,
            completion_per_million: 10,
            input_cache_read_per_million: 0.1,
            input_cache_write_per_million: 0.1875,
          },
        },
      ],
    },
  ],
};

export function getCustomPricing(
  config: CustomPricingConfig,
  modelId: string
): CustomPricing | undefined {
  return config.models.find(entry => entry.model === modelId);
}

export function formatPricePerToken(pricePerMillion: number): string {
  return (pricePerMillion / 1_000_000).toFixed(12);
}
