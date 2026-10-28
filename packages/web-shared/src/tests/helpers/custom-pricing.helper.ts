import type { CustomPricingConfig } from '@kilocode/db/schema-types';
import { GEMINI_4_ARGON_MODEL_ID } from '@kilocode/web-shared/lib/ai-gateway/providers/google';

/** 50% discounts on two Gemini models. */
export const TEST_CUSTOM_PRICING_CONFIG: CustomPricingConfig = {
  models: [
    {
      model: 'google/gemini-3.8-flash',
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
