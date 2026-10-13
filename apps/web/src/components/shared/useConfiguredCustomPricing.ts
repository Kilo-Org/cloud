'use client';

import { useQuery } from '@tanstack/react-query';
import type { ConfiguredCustomPricing } from '@kilocode/web-shared/lib/ai-gateway/custom-pricing.constants';
import { useTRPC } from '@/lib/trpc/utils';

const NO_CONFIGURED_CUSTOM_PRICING: ConfiguredCustomPricing = {};

export function useConfiguredCustomPricing(): ConfiguredCustomPricing {
  const trpc = useTRPC();
  const { data } = useQuery({
    ...trpc.models.customPricing.queryOptions(),
    staleTime: 5 * 60_000,
  });
  return data ?? NO_CONFIGURED_CUSTOM_PRICING;
}
