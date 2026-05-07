import 'server-only';
import { normalizeModelId } from '@/lib/ai-gateway/model-utils';
import { getProviderSlugsForModel } from '@/lib/ai-gateway/providers/openrouter/models-by-provider-index.server';

export type ProviderAwareAllowPredicate = (modelId: string) => Promise<boolean>;

export type ModelRestrictions = {
  providerAllowList?: string[];
  modelDenyList: string[];
};

export type ProviderLookup = (modelId: string) => Promise<ReadonlySet<string>>;

export function hasActiveModelRestrictions(restrictions: ModelRestrictions): boolean {
  return restrictions.providerAllowList !== undefined || restrictions.modelDenyList.length > 0;
}

export function createAllowPredicateFromProviderAllowList(
  modelDenyList: string[] | undefined,
  providerAllowList: string[] | undefined,
  providerLookup: ProviderLookup = getProviderSlugsForModel
): ProviderAwareAllowPredicate {
  const modelDenySet = new Set(modelDenyList?.map(normalizeModelId));
  const providerAllowSet = providerAllowList ? new Set(providerAllowList) : undefined;
  return async (modelId: string): Promise<boolean> => {
    const normalizedModelId = normalizeModelId(modelId);
    if (modelDenySet.has(normalizedModelId)) {
      return false;
    }
    if (!providerAllowSet) {
      return true;
    }
    const providerSlugs = await providerLookup(normalizedModelId);
    if (providerSlugs.size === 0) return true;
    return [...providerSlugs].some(slug => providerAllowSet.has(slug));
  };
}

export function createAllowPredicateFromRestrictions(
  restrictions: ModelRestrictions,
  providerLookup: ProviderLookup = getProviderSlugsForModel
): ProviderAwareAllowPredicate {
  return createAllowPredicateFromProviderAllowList(
    restrictions.modelDenyList,
    restrictions.providerAllowList,
    providerLookup
  );
}
