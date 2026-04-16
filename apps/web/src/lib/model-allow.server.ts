import 'server-only';
import { normalizeModelId } from '@/lib/ai-gateway/model-utils';
import { getProviderSlugsForModel } from '@/lib/ai-gateway/providers/openrouter/models-by-provider-index.server';

export type ProviderAwareAllowPredicate = (modelId: string) => Promise<boolean>;

export function createAllowPredicateFromDenyList(
  modelDenyList: string[] | undefined,
  providerDenyList: string[] | undefined
): ProviderAwareAllowPredicate {
  const modelDenySet = new Set(modelDenyList?.map(normalizeModelId));
  const providerDenySet = new Set(providerDenyList);
  return async (modelId: string): Promise<boolean> => {
    const normalizedModelId = normalizeModelId(modelId);
    if (modelDenySet.has(normalizedModelId)) {
      return false;
    }
    if (providerDenySet.size > 0) {
      const providerSlugs = await getProviderSlugsForModel(normalizedModelId);
      if (providerSlugs.size > 0 && [...providerSlugs].every(slug => providerDenySet.has(slug))) {
        return false;
      }
    }
    return true;
  };
}
