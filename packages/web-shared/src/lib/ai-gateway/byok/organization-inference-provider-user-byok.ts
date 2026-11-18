import { readDb } from '@kilocode/web-shared/lib/drizzle';
import {
  getEnabledByokProviders,
  hasInferenceProviderUserByokForModel,
} from '@kilocode/web-shared/lib/ai-gateway/byok';
import { getByokEndpointCatalogModelIds } from '@kilocode/web-shared/lib/ai-gateway/byok-endpoint/models';
import { getDirectByokCatalogModelIds } from '@kilocode/web-shared/lib/ai-gateway/providers/direct-byok';
import { isCustomLlm } from '@kilocode/web-shared/lib/ai-gateway/custom-llm/custom-llm-catalog';
import {
  isModelAllowedForProviderKey,
  type EffectiveOrganizationModelPolicy,
} from '@kilocode/web-shared/lib/organizations/group-policies/model-access/model-access.server';

/**
 * The catalog ids the organization's catalog-mode direct BYOK keys serve under `policy`, as
 * `getProvider` routes them: an id counts when the policy admits it for the provider of a key that
 * serves it (see `isModelAllowedForProviderKey`), whatever it decides for Kilo's routes. An id a
 * custom LLM owns does not count, because `getProvider` serves the custom LLM first.
 */
export async function getAllowedDirectByokCatalogModelIds(
  organizationId: string,
  policy: EffectiveOrganizationModelPolicy
): Promise<ReadonlySet<string>> {
  return getDirectByokCatalogModelIds(
    { type: 'organization', id: organizationId },
    async (catalogModelId, target) =>
      !(await isCustomLlm(catalogModelId)) &&
      (await isModelAllowedForProviderKey(policy, catalogModelId, target.providerSlug))
  );
}

/**
 * The models among `modelIds` that the organization's own keys serve although the provider
 * allow-list admits none of their providers: provider keys sent through Vercel (see
 * `hasInferenceProviderUserByokForModel`) and catalog-mode endpoints, which the allow-list never
 * restricts.
 */
export async function modelsServedByOrganizationInferenceProviderUserByok(
  organizationId: string,
  modelIds: readonly string[]
): Promise<string[]> {
  if (modelIds.length === 0) return [];
  const keys = await getEnabledByokProviders(readDb, { type: 'organization', id: organizationId });
  const providerIds = keys.map(key => key.providerId);
  const endpointCatalogModelIds = await getByokEndpointCatalogModelIds(keys);
  const served = await Promise.all(
    modelIds.map(
      async modelId =>
        endpointCatalogModelIds.has(modelId) ||
        (await hasInferenceProviderUserByokForModel(modelId, providerIds))
    )
  );
  return modelIds.filter((_modelId, index) => served[index]);
}
