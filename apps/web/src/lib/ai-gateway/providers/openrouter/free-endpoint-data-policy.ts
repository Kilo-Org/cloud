import type { KiloExclusiveModel } from '@/lib/ai-gateway/providers/kilo-exclusive-model';
import {
  isForbiddenFreeModel,
  isForbiddenFreeModelFamily,
} from '@/lib/ai-gateway/forbidden-free-models';
import { normalizeModelId } from '@/lib/ai-gateway/model-utils';
import { normalizeInferenceProviderId } from '@/lib/ai-gateway/providers/openrouter/inference-provider-id';
import type { OpenRouterModel } from '@/lib/ai-gateway/providers/openrouter/openrouter-types';

type ProviderModels = Array<{
  provider: { slug: string };
  models: OpenRouterModel[];
}>;

export function getOpenRouterFreeEndpointKeys(providerModelData: ProviderModels): Set<string> {
  const keys = new Set<string>();
  for (const { provider, models } of providerModelData) {
    const providerId = normalizeInferenceProviderId(provider.slug);
    for (const model of models) {
      if (model.endpoint?.is_free && !isForbiddenFreeModelFamily(model.slug)) {
        keys.add(`${normalizeModelId(model.slug)}:${providerId}`);
      }
    }
  }
  return keys;
}

function dataCollectingKiloExclusiveModels(
  kiloExclusiveModels: ReadonlyArray<KiloExclusiveModel>
): Map<string, ReadonlySet<string> | null> {
  const models = new Map<string, ReadonlySet<string> | null>();
  for (const model of kiloExclusiveModels) {
    const collectsData = model.pricing === null || model.flags.includes('requires-data-collection');
    if (model.status !== 'public' || !collectsData || isForbiddenFreeModel(model.public_id))
      continue;
    const modelId = normalizeModelId(model.public_id);
    if (model.inference_provider_restriction.length === 0) {
      models.set(modelId, null);
      continue;
    }
    const existing = models.get(modelId);
    if (existing === null) continue;
    models.set(
      modelId,
      new Set([
        ...(existing ?? []),
        ...model.inference_provider_restriction.map(providerId =>
          normalizeInferenceProviderId(providerId)
        ),
      ])
    );
  }
  return models;
}

export function applyFreeEndpointDataPolicy({
  providerModelData,
  openRouterFreeEndpointKeys,
  kiloExclusiveModels,
}: {
  providerModelData: ProviderModels;
  openRouterFreeEndpointKeys: ReadonlySet<string>;
  kiloExclusiveModels: ReadonlyArray<KiloExclusiveModel>;
}): void {
  const exclusiveModels = dataCollectingKiloExclusiveModels(kiloExclusiveModels);

  for (const { provider, models } of providerModelData) {
    const providerId = normalizeInferenceProviderId(provider.slug);
    for (const model of models) {
      if (!model.endpoint) continue;

      const modelId = normalizeModelId(model.slug);
      const restrictions = exclusiveModels.get(modelId);
      const hasFreeExclusiveEndpoint =
        exclusiveModels.has(modelId) && (restrictions === null || restrictions?.has(providerId));
      const hasFreeOpenRouterEndpoint = openRouterFreeEndpointKeys.has(`${modelId}:${providerId}`);
      if (!hasFreeExclusiveEndpoint && !hasFreeOpenRouterEndpoint) continue;

      model.endpoint.data_policy = {
        ...model.endpoint.data_policy,
        training: true,
        retainsPrompts: true,
      };
    }
  }
}
