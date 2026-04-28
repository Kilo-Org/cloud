import 'server-only';
import { normalizeModelId } from '@/lib/ai-gateway/model-utils';
import { getProviderSlugsForModel } from '@/lib/ai-gateway/providers/openrouter/models-by-provider-index.server';

export type ProviderAwareAllowPredicate = (modelId: string) => Promise<boolean>;

export type ModelRestrictions = {
  providerAllowList?: string[];
  modelDenyList: string[];
  providerDenyList: string[];
};

export type ProviderLookup = (modelId: string) => Promise<ReadonlySet<string>>;

export function hasActiveModelRestrictions(restrictions: ModelRestrictions): boolean {
  return (
    restrictions.providerAllowList !== undefined ||
    restrictions.modelDenyList.length > 0 ||
    restrictions.providerDenyList.length > 0
  );
}

export function createAllowPredicateFromDenyList(
  modelDenyList: string[] | undefined,
  providerDenyList: string[] | undefined,
  providerLookup: ProviderLookup = getProviderSlugsForModel
): ProviderAwareAllowPredicate {
  const modelDenySet = new Set(modelDenyList?.map(normalizeModelId));
  const providerDenySet = new Set(providerDenyList);
  return async (modelId: string): Promise<boolean> => {
    const normalizedModelId = normalizeModelId(modelId);
    if (modelDenySet.has(normalizedModelId)) {
      return false;
    }
    if (providerDenySet.size > 0) {
      const providerSlugs = await providerLookup(normalizedModelId);
      if (providerSlugs.size > 0 && [...providerSlugs].every(slug => providerDenySet.has(slug))) {
        return false;
      }
    }
    return true;
  };
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

function legacyDenyListsActive(restrictions: ModelRestrictions): boolean {
  return (
    restrictions.providerAllowList === undefined &&
    (restrictions.modelDenyList.length > 0 || restrictions.providerDenyList.length > 0)
  );
}

export function createAllowPredicateFromRestrictions(
  restrictions: ModelRestrictions,
  providerLookup: ProviderLookup = getProviderSlugsForModel
): ProviderAwareAllowPredicate {
  if (legacyDenyListsActive(restrictions)) {
    return createAllowPredicateFromDenyList(
      restrictions.modelDenyList,
      restrictions.providerDenyList,
      providerLookup
    );
  }
  if (restrictions.providerAllowList !== undefined) {
    return createAllowPredicateFromProviderAllowList(
      restrictions.modelDenyList,
      restrictions.providerAllowList,
      providerLookup
    );
  }
  return createAllowPredicateFromDenyList(
    restrictions.modelDenyList,
    restrictions.providerDenyList,
    providerLookup
  );
}
