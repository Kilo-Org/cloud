import type { KiloExclusiveModel } from '@/lib/ai-gateway/providers/kilo-exclusive-model';
import { normalizeModelId } from '@/lib/ai-gateway/model-utils';
import { normalizeInferenceProviderId } from '@/lib/ai-gateway/providers/openrouter/inference-provider-id';
import type { OpenRouterModel } from '@/lib/ai-gateway/providers/openrouter/openrouter-types';
import type { StoredModel } from '@kilocode/db/schema-types';

type ProviderModels = Array<{
  provider: { slug: string };
  models: OpenRouterModel[];
}>;

function isZeroPrice(price: string | undefined): boolean {
  if (price === undefined || price.trim() === '') return false;
  const value = Number(price);
  return Number.isFinite(value) && value === 0;
}

function freeOpenRouterEndpointKeys(openRouterModels: Record<string, StoredModel>): Set<string> {
  const keys = new Set<string>();
  for (const model of Object.values(openRouterModels)) {
    const modelId = normalizeModelId(model.id);
    for (const endpoint of model.endpoints) {
      if (
        endpoint.tag &&
        isZeroPrice(endpoint.pricing?.prompt) &&
        isZeroPrice(endpoint.pricing?.completion)
      ) {
        keys.add(`${modelId}:${normalizeInferenceProviderId(endpoint.tag)}`);
      }
    }
  }
  return keys;
}

function freeKiloExclusiveModels(
  kiloExclusiveModels: ReadonlyArray<KiloExclusiveModel>
): Map<string, ReadonlySet<string> | null> {
  const models = new Map<string, ReadonlySet<string> | null>();
  for (const model of kiloExclusiveModels) {
    if (model.status === 'disabled' || model.pricing !== null) continue;
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
  openRouterModels,
  kiloExclusiveModels,
}: {
  providerModelData: ProviderModels;
  openRouterModels: Record<string, StoredModel>;
  kiloExclusiveModels: ReadonlyArray<KiloExclusiveModel>;
}): void {
  const openRouterEndpointKeys = freeOpenRouterEndpointKeys(openRouterModels);
  const exclusiveModels = freeKiloExclusiveModels(kiloExclusiveModels);

  for (const { provider, models } of providerModelData) {
    const providerId = normalizeInferenceProviderId(provider.slug);
    for (const model of models) {
      if (!model.endpoint) continue;

      const modelId = normalizeModelId(model.slug);
      const restrictions = exclusiveModels.get(modelId);
      const hasFreeExclusiveEndpoint =
        exclusiveModels.has(modelId) && (restrictions === null || restrictions?.has(providerId));
      const hasFreeOpenRouterEndpoint = openRouterEndpointKeys.has(`${modelId}:${providerId}`);
      if (!hasFreeExclusiveEndpoint && !hasFreeOpenRouterEndpoint) continue;

      model.endpoint.data_policy = {
        ...model.endpoint.data_policy,
        training: true,
        retainsPrompts: true,
      };
    }
  }
}
