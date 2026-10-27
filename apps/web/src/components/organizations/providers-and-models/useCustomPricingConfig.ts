'use client';

import { useQuery } from '@tanstack/react-query';
import type { CustomPricingConfig } from '@kilocode/db/schema-types';
import { CUSTOM_PRICING_FALLBACK_CONFIG } from '@kilocode/web-shared/lib/ai-gateway/custom-pricing.constants';
import { useTRPC } from '@/lib/trpc/utils';

/** The custom pricing Kilo bills; the in-code fallback is used until the stored value loads. */
export function useCustomPricingConfig(): CustomPricingConfig {
  const trpc = useTRPC();
  const { data } = useQuery({
    ...trpc.models.customPricing.queryOptions(),
    staleTime: 5 * 60_000,
  });
  return data ?? CUSTOM_PRICING_FALLBACK_CONFIG;
}
