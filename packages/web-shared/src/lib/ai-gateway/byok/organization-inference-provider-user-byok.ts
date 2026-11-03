import { readDb } from '@kilocode/web-shared/lib/drizzle';
import {
  getOrganizationByokProviderIds,
  hasInferenceProviderUserByokForModel,
} from '@kilocode/web-shared/lib/ai-gateway/byok';
import { getDirectByokCatalogModelIds } from '@kilocode/web-shared/lib/ai-gateway/providers/direct-byok';
import { isCustomLlm } from '@kilocode/web-shared/lib/ai-gateway/custom-llm/custom-llm-catalog';
import {
  isModelAllowedForProviderKey,
  type EffectiveOrganizationModelPolicy,
} from '@kilocode/web-shared/lib/organizations/effective-model-access.server';

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
    async (catalogModelId, policyProviderId) =>
      !(await isCustomLlm(catalogModelId)) &&
      (await isModelAllowedForProviderKey(policy, catalogModelId, policyProviderId))
  );
}

/**
 * The models among `modelIds` that the organization's provider keys sent through Vercel serve
 * although the provider allow-list admits none of their providers (see
 * `hasInferenceProviderUserByokForModel`).
 */
export async function modelsServedByOrganizationInferenceProviderUserByok(
  organizationId: string,
  modelIds: readonly string[]
): Promise<string[]> {
  if (modelIds.length === 0) return [];
  const providerIds = await getOrganizationByokProviderIds(readDb, organizationId);
  const served = await Promise.all(
    modelIds.map(modelId => hasInferenceProviderUserByokForModel(modelId, providerIds))
  );
  return modelIds.filter((_modelId, index) => served[index]);
}
