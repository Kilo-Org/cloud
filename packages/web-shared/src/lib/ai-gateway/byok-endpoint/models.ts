import type {
  ByokEndpointDefinition,
  ByokEndpointModel,
  ByokEndpointProviderId,
} from '@kilocode/db/schema-types';
import type { OpenRouterModel } from '@kilocode/web-shared/lib/organizations/organization-types';
import {
  getEnabledByokProviders,
  type ByokSourceDb,
  type EnabledByokProvider,
} from '@kilocode/web-shared/lib/ai-gateway/byok';
import {
  formatByokEndpointModelId,
  getByokEndpointModelClientProvider,
  isByokEndpointProviderId,
} from '@kilocode/web-shared/lib/ai-gateway/byok-endpoint';
import { isByokEndpointCatalogModelCandidate } from '@kilocode/web-shared/lib/ai-gateway/byok-endpoint/catalog';
import { getFallbackReasoningOptions } from '@kilocode/web-shared/lib/ai-gateway/providers/reasoning-options';
import { toByokListedModel } from '@kilocode/web-shared/lib/ai-gateway/providers/byok-listed-model';
import { readDb } from '@kilocode/web-shared/lib/drizzle';
import { isCustomLlm } from '@kilocode/web-shared/lib/ai-gateway/custom-llm/custom-llm-catalog';

export type ByokEndpointKey = {
  providerId: ByokEndpointProviderId;
  serveCatalogModels: boolean;
  endpoint: ByokEndpointDefinition;
};

/** The endpoint keys among `keys`, with their definitions. */
export function getByokEndpointKeys(keys: readonly EnabledByokProvider[]): ByokEndpointKey[] {
  return keys.flatMap(({ providerId, serveCatalogModels, endpoint }) =>
    endpoint && isByokEndpointProviderId(providerId)
      ? [{ providerId, serveCatalogModels, endpoint }]
      : []
  );
}

/** A bespoke endpoint model as model lists show it. Its endpoint's credentials pay for it. */
export function convertByokEndpointModel(
  providerId: ByokEndpointProviderId,
  endpoint: ByokEndpointDefinition,
  model: ByokEndpointModel
): OpenRouterModel {
  const clientProvider = getByokEndpointModelClientProvider(endpoint, model);
  return toByokListedModel({
    id: formatByokEndpointModelId(providerId, model),
    name: `${endpoint.name}: ${model.name ?? model.id}`,
    model,
    aiSdkProvider: clientProvider === 'openrouter' ? undefined : clientProvider,
    reasoningOptions: model.flags?.includes('reasoning')
      ? (getFallbackReasoningOptions(model.id) ?? getFallbackReasoningOptions(model.internal_id))
      : undefined,
  });
}

/** The bespoke models of the enabled endpoints outside catalog mode, which serve them under their own ids. */
export function getByokEndpointModels(keys: readonly EnabledByokProvider[]): OpenRouterModel[] {
  return getByokEndpointKeys(keys)
    .filter(key => !key.serveCatalogModels)
    .flatMap(({ providerId, endpoint }) =>
      endpoint.models.map(model => convertByokEndpointModel(providerId, endpoint, model))
    );
}

/**
 * The catalog ids the enabled catalog-mode endpoints serve. The organization model policy still
 * decides whether a member may use each one (see `allowsInferenceProviderUserByok`). An id a custom
 * LLM owns does not count, because `getProvider` serves the custom LLM first.
 */
export async function getByokEndpointCatalogModelIds(
  keys: readonly EnabledByokProvider[]
): Promise<ReadonlySet<string>> {
  const modelIds = new Set<string>();
  for (const { serveCatalogModels, endpoint } of getByokEndpointKeys(keys)) {
    if (!serveCatalogModels) continue;
    for (const model of endpoint.models) {
      if (
        !modelIds.has(model.id) &&
        (await isByokEndpointCatalogModelCandidate(model.id)) &&
        !(await isCustomLlm(model.id))
      ) {
        modelIds.add(model.id);
      }
    }
  }
  return modelIds;
}

/** The bespoke endpoint models the organization's enabled endpoints serve. */
export async function getByokEndpointModelsForOrganization(
  organizationId: string,
  fromDb: ByokSourceDb = readDb
): Promise<OpenRouterModel[]> {
  return getByokEndpointModels(
    await getEnabledByokProviders(fromDb, { type: 'organization', id: organizationId })
  );
}

/** The catalog ids the organization's enabled catalog-mode endpoints serve. */
export async function getByokEndpointCatalogModelIdsForOrganization(
  organizationId: string,
  fromDb: ByokSourceDb = readDb
): Promise<ReadonlySet<string>> {
  return getByokEndpointCatalogModelIds(
    await getEnabledByokProviders(fromDb, { type: 'organization', id: organizationId })
  );
}
