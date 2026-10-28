import { familyHasUnavailableFreeModel } from '@kilocode/web-shared/lib/ai-gateway/unavailable-models';
import { normalizeModelId } from '@kilocode/web-shared/lib/ai-gateway/model-utils';
import { normalizeInferenceProviderId } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/inference-provider-id';
import type { OpenRouterModel } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/openrouter-types';

type ProviderModels = Array<{
  provider: { slug: string };
  models: OpenRouterModel[];
}>;

export type OpenRouterFreeEndpoint = {
  modelId: string;
  providerId: string;
};

export function getOpenRouterFreeEndpoints(
  providerModelData: ProviderModels,
  unavailableModelIds: ReadonlySet<string>
): OpenRouterFreeEndpoint[] {
  const endpoints: OpenRouterFreeEndpoint[] = [];
  for (const { provider, models } of providerModelData) {
    const providerId = normalizeInferenceProviderId(provider.slug);
    for (const model of models) {
      if (
        model.endpoint?.is_free &&
        !familyHasUnavailableFreeModel(unavailableModelIds, model.slug)
      ) {
        endpoints.push({ modelId: normalizeModelId(model.slug), providerId });
      }
    }
  }
  return endpoints;
}

export function applyFreeEndpointDataPolicy({
  providerModelData,
  openRouterFreeEndpoints,
  kiloExclusiveModelIds,
  unavailableModelIds,
}: {
  providerModelData: ProviderModels;
  openRouterFreeEndpoints: ReadonlyArray<OpenRouterFreeEndpoint>;
  kiloExclusiveModelIds: ReadonlyArray<string>;
  unavailableModelIds: ReadonlySet<string>;
}): void {
  const exclusiveModelIds = new Set(
    kiloExclusiveModelIds
      .filter(modelId => !unavailableModelIds.has(modelId))
      .map(modelId => normalizeModelId(modelId))
  );

  for (const { provider, models } of providerModelData) {
    const providerId = normalizeInferenceProviderId(provider.slug);
    for (const model of models) {
      if (!model.endpoint) continue;

      const modelId = normalizeModelId(model.slug);
      const hasFreeOpenRouterEndpoint = openRouterFreeEndpoints.some(
        endpoint => endpoint.modelId === modelId && endpoint.providerId === providerId
      );
      if (!exclusiveModelIds.has(modelId) && !hasFreeOpenRouterEndpoint) continue;

      model.endpoint.data_policy = {
        ...model.endpoint.data_policy,
        training: true,
        retainsPrompts: true,
      };
    }
  }
}
