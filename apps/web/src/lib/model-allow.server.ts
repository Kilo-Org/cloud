import 'server-only';
import { CUSTOM_LLM_PREFIX, normalizeModelId } from '@/lib/ai-gateway/model-utils';
import { getDirectByokModel } from '@/lib/ai-gateway/providers/direct-byok';
import { getProviderSlugsForModel } from '@/lib/ai-gateway/providers/openrouter/models-by-provider-index.server';

export type ProviderAwareAllowPredicate = (modelId: string) => Promise<boolean>;

export type ModelRestrictions = {
  requireModelInCurrentSnapshot?: boolean;
  providerAllowList?: string[];
  modelDenyList: string[];
};

export type ProviderLookup = (modelId: string) => Promise<ReadonlySet<string>>;

export async function isModelRestrictionExempt(modelId: string): Promise<boolean> {
  const requestedModelId = modelId.trim().toLowerCase();
  if (requestedModelId.startsWith(CUSTOM_LLM_PREFIX)) return true;
  const directByokModel = await getDirectByokModel(requestedModelId);
  return directByokModel.provider !== null && directByokModel.model !== null;
}

export function hasActiveModelRestrictions(restrictions: ModelRestrictions): boolean {
  return restrictions.providerAllowList !== undefined || restrictions.modelDenyList.length > 0;
}

export function createAllowPredicateFromProviderAllowList(
  modelDenyList: string[] | undefined,
  providerAllowList: string[] | undefined,
  providerLookup: ProviderLookup = getProviderSlugsForModel,
  requireModelInCurrentSnapshot = providerAllowList !== undefined
): ProviderAwareAllowPredicate {
  const modelDenySet = new Set(modelDenyList?.map(normalizeModelId));
  const providerAllowSet = providerAllowList ? new Set(providerAllowList) : undefined;
  return async (modelId: string): Promise<boolean> => {
    const normalizedModelId = normalizeModelId(modelId);
    if (await isModelRestrictionExempt(modelId)) return true;
    if (modelDenySet.has(normalizedModelId)) {
      return false;
    }
    if (!providerAllowSet && !requireModelInCurrentSnapshot) {
      return true;
    }
    const providerSlugs = await providerLookup(normalizedModelId);
    if (providerSlugs.size === 0) return false;
    if (!providerAllowSet) return true;
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
    providerLookup,
    restrictions.requireModelInCurrentSnapshot
  );
}
