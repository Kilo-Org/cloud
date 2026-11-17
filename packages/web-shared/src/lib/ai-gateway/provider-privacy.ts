import { z } from 'zod';
import type { OpenRouterProviderConfig } from './providers/openrouter/types';

export const providerPrivacySchema = z.object({
  data_collection: z.enum(['allow', 'deny']).optional(),
  zdr: z.boolean().optional(),
});

const providerIdsSchema = z.array(z.string()).nullish();

/**
 * Validates the request `provider` fields the gateway reads itself. Parsing strips other fields,
 * so callers forward the original object to keep the remaining OpenRouter options.
 */
export const providerPreferencesSchema = providerPrivacySchema.extend({
  order: providerIdsSchema,
  only: providerIdsSchema,
  ignore: providerIdsSchema,
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
