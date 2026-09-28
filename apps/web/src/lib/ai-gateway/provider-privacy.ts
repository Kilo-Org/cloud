import { z } from 'zod';
import type { OpenRouterProviderConfig } from './providers/openrouter/types';

export const providerPrivacySchema = z.object({
  data_collection: z.enum(['allow', 'deny']).optional(),
  zdr: z.boolean().optional(),
});

export function getEffectiveProviderPrivacy(
  requestProvider: Pick<OpenRouterProviderConfig, 'data_collection' | 'zdr'> | undefined,
  organizationDataCollection?: OpenRouterProviderConfig['data_collection'] | null
): Pick<OpenRouterProviderConfig, 'data_collection' | 'zdr'> {
  const dataCollection =
    requestProvider?.data_collection === 'deny' || organizationDataCollection === 'deny'
      ? 'deny'
      : (organizationDataCollection ?? requestProvider?.data_collection);

  return {
    ...(dataCollection !== undefined && { data_collection: dataCollection }),
    ...(requestProvider?.zdr !== undefined && { zdr: requestProvider.zdr }),
  };
}
