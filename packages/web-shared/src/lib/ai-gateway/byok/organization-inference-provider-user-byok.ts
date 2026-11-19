import { readDb } from '@kilocode/web-shared/lib/drizzle';
import {
  getOrganizationByokProviderIds,
  hasInferenceProviderUserByokForModel,
} from '@kilocode/web-shared/lib/ai-gateway/byok';
import {
  getDirectByokCatalogModelIds,
  type DirectByokPolicyTarget,
} from '@kilocode/web-shared/lib/ai-gateway/providers/direct-byok';
import { isCustomLlm } from '@kilocode/web-shared/lib/ai-gateway/custom-llm/custom-llm-catalog';
import {
  allowsInferenceProviderUserByok,
  getEffectiveModelDecision,
  isModelAllowedForProviderKey,
  type EffectiveOrganizationModelPolicy,
} from '@kilocode/web-shared/lib/organizations/group-policies/model-access/model-access.server';

/**
 * Whether `policy` admits `modelId` served by the organization's catalog-mode direct BYOK key with
 * policy target `target`: checked against the key's provider alone (see
 * `isModelAllowedForProviderKey`), or, for the organization's own private provider, which provider
 * allow-lists cannot name, against its model policy alone (see `allowsInferenceProviderUserByok`).
 */
export async function isModelAllowedForDirectByokKey(
  policy: EffectiveOrganizationModelPolicy,
  modelId: string,
  target: DirectByokPolicyTarget
): Promise<boolean> {
  return target.kind === 'provider'
    ? isModelAllowedForProviderKey(policy, modelId, target.providerSlug)
    : allowsInferenceProviderUserByok(await getEffectiveModelDecision(policy, modelId));
}

/**
 * The catalog ids the organization's catalog-mode direct BYOK keys and private providers serve under
 * `policy`, as `getProvider` routes them: an id counts when the policy admits it for a key that
 * serves it (see `isModelAllowedForDirectByokKey`), whatever it decides for Kilo's routes. An id a
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
      (await isModelAllowedForDirectByokKey(policy, catalogModelId, target))
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
