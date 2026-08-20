import type { PricingTiers } from '@/lib/ai-gateway/providers/kilo-exclusive-model';
import {
  FRIENDLI_GLM_PUBLIC_ID,
  PERPLEXITY_KIMI_PUBLIC_ID,
} from '@/lib/ai-gateway/providers/partner/constants';

type PartnerPricing = {
  fallbackOnly: true;
  pricing: PricingTiers;
};

export const partnerPricingByModelId = {
  [PERPLEXITY_KIMI_PUBLIC_ID]: {
    fallbackOnly: true,
    pricing: [
      {
        start_context_length: 0,
        pricing: {
          prompt_per_million: 3,
          completion_per_million: 15,
          input_cache_read_per_million: 0.3,
          input_cache_write_per_million: null,
        },
      },
    ],
  },
  [FRIENDLI_GLM_PUBLIC_ID]: {
    fallbackOnly: true,
    pricing: [
      {
        start_context_length: 0,
        pricing: {
          prompt_per_million: 1.4,
          completion_per_million: 4.4,
          input_cache_read_per_million: 0.26,
          input_cache_write_per_million: null,
        },
      },
    ],
  },
} satisfies Record<string, PartnerPricing>;
