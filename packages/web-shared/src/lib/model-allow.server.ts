import 'server-only';
import {
  KILO_AUTO_MODEL_PREFIX,
  normalizeModelId,
} from '@kilocode/web-shared/lib/ai-gateway/model-utils';
import {
  findCustomLlm,
  getPublicCustomLlmInferenceProviders,
} from '@kilocode/web-shared/lib/ai-gateway/custom-llm/custom-llm-catalog';
import { hasCustomLlmAccess } from '@kilocode/web-shared/lib/ai-gateway/custom-llm/access';
import {
  getByokEndpointProviders,
  getDirectByokModel,
} from '@kilocode/web-shared/lib/ai-gateway/providers/direct-byok';
import type { DirectByokProvider } from '@kilocode/web-shared/lib/ai-gateway/providers/direct-byok/types';
import { isByokEndpointModelId } from '@kilocode/web-shared/lib/ai-gateway/byok-endpoint';
import { getEnabledByokProviders } from '@kilocode/web-shared/lib/ai-gateway/byok';
import { readDb } from '@kilocode/web-shared/lib/drizzle';
import { getProviderSlugsForModel } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/models-by-provider-index.server';

export type ProviderAwareAllowPredicate = (modelId: string) => Promise<boolean>;

/** The organization, and the member's groups in it, whose custom LLM grants apply. */
export type CustomLlmGrantee = { organizationId: string; groupIds: readonly string[] };

export type ModelRestrictions = {
  requireModelInCurrentSnapshot: boolean;
  providerAllowList?: string[];
  modelDenyList: string[];
  /** Without a grantee no custom LLM is exempt from these restrictions. */
  customLlmGrantee?: CustomLlmGrantee;
};

/**
 * Resolves the providers that can serve a model. Receives the requested model id
 * as-is (including variant suffixes such as `:free`) so implementations can
 * distinguish variants that are served by different providers.
 */
export type ProviderLookup = (modelId: string) => Promise<ReadonlySet<string>>;

/**
 * The grantee organization's enabled endpoints outside catalog mode, which serve their models
 * under the endpoint model ids. A catalog-mode endpoint serves only catalog ids, which the policy
 * covers.
 */
async function getBespokeEndpointProviders(
  customLlmGrantee: CustomLlmGrantee | undefined
): Promise<DirectByokProvider[]> {
  if (!customLlmGrantee) return [];
  const keys = await getEnabledByokProviders(readDb, {
    type: 'organization',
    id: customLlmGrantee.organizationId,
  });
  return getByokEndpointProviders(keys.filter(key => !key.serveCatalogModels));
}

/**
 * A custom LLM is exempt only for a grantee it is granted to: a Kilo admin
 * allowlisted that organization or group, which overrides organization policy.
 * An endpoint model is exempt only for the organization whose enabled endpoint lists it.
 */
export async function isModelRestrictionExempt(
  modelId: string,
  customLlmGrantee: CustomLlmGrantee | undefined
): Promise<boolean> {
  const requestedModelId = modelId.trim().toLowerCase();
  if (requestedModelId.startsWith(KILO_AUTO_MODEL_PREFIX)) {
    return true;
  }
  const customLlm = await findCustomLlm(requestedModelId);
  if (customLlm) {
    return (
      customLlmGrantee !== undefined &&
      hasCustomLlmAccess(
        customLlm.definition,
        customLlmGrantee.organizationId,
        customLlmGrantee.groupIds
      )
    );
  }
  const directByokModel = await getDirectByokModel(
    requestedModelId,
    isByokEndpointModelId(requestedModelId)
      ? await getBespokeEndpointProviders(customLlmGrantee)
      : undefined
  );
  return directByokModel.provider !== null && directByokModel.model !== null;
}

/**
 * Providers a model is pinned to regardless of the snapshot: those a public
 * custom LLM declares. Undefined when the snapshot decides.
 */
export async function getModelInferenceProviders(
  modelId: string
): Promise<ReadonlySet<string> | undefined> {
  return (await getPublicCustomLlmInferenceProviders(modelId)) ?? undefined;
}

export function hasActiveModelRestrictions(restrictions: ModelRestrictions): boolean {
  return restrictions.providerAllowList !== undefined || restrictions.modelDenyList.length > 0;
}

export function createAllowPredicateFromProviderAllowList(
  modelDenyList: string[] | undefined,
  providerAllowList: string[] | undefined,
  providerLookup: ProviderLookup = getProviderSlugsForModel,
  requireModelInCurrentSnapshot = false,
  customLlmGrantee?: CustomLlmGrantee
): ProviderAwareAllowPredicate {
  const modelDenySet = new Set(modelDenyList?.map(normalizeModelId));
  const providerAllowSet = providerAllowList ? new Set(providerAllowList) : undefined;
  return async (modelId: string): Promise<boolean> => {
    const normalizedModelId = normalizeModelId(modelId);
    if (!requireModelInCurrentSnapshot && !providerAllowSet && modelDenySet.size === 0) return true;
    if (await isModelRestrictionExempt(modelId, customLlmGrantee)) return true;
    if (modelDenySet.has(normalizedModelId)) {
      return false;
    }
    const providerSlugs =
      (await getModelInferenceProviders(modelId)) ?? (await providerLookup(modelId));
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
    restrictions.requireModelInCurrentSnapshot,
    restrictions.customLlmGrantee
  );
}
