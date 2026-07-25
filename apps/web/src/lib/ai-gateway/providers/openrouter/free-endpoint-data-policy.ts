import { normalizeModelId } from '@/lib/ai-gateway/model-utils';
import type { KiloExclusiveModel } from '@/lib/ai-gateway/providers/kilo-exclusive-model';
import type {
  OpenRouterModel,
  OpenRouterProvider,
} from '@/lib/ai-gateway/providers/openrouter/openrouter-types';

function kiloExclusiveModelAppliesToProvider(
  model: KiloExclusiveModel,
  providerSlug: string
): boolean {
  const restriction = model.inference_provider_restriction;
  return restriction.length === 0 || restriction.some(slug => slug === providerSlug);
}

export function normalizeProviderModelsWithDataPolicy(
  provider: OpenRouterProvider,
  models: OpenRouterModel[],
  kiloExclusiveModels: KiloExclusiveModel[]
): Pick<OpenRouterProvider, 'dataPolicy'> & { models: OpenRouterModel[] } {
  const uniqueModelsMap = new Map<string, OpenRouterModel>();
  const freeEndpointModelIds = new Set<string>();

  for (const model of models) {
    const normalizedModelId = normalizeModelId(model.slug);
    uniqueModelsMap.set(normalizedModelId, model);
    if (model.endpoint?.is_free) {
      freeEndpointModelIds.add(normalizedModelId);
    }
  }

  for (const model of kiloExclusiveModels) {
    const normalizedModelId = normalizeModelId(model.public_id);
    if (
      model.status !== 'disabled' &&
      model.pricing === null &&
      uniqueModelsMap.has(normalizedModelId) &&
      kiloExclusiveModelAppliesToProvider(model, provider.slug)
    ) {
      freeEndpointModelIds.add(normalizedModelId);
    }
  }

  const hasFreeEndpoint = freeEndpointModelIds.size > 0;
  return {
    dataPolicy: {
      training: provider.dataPolicy.training || hasFreeEndpoint,
      retainsPrompts: provider.dataPolicy.retainsPrompts || hasFreeEndpoint,
      canPublish: provider.dataPolicy.canPublish,
    },
    models: [...uniqueModelsMap.entries()].map(([normalizedModelId, model]) => {
      if (!model.endpoint || !freeEndpointModelIds.has(normalizedModelId)) {
        return model;
      }
      return {
        ...model,
        endpoint: {
          ...model.endpoint,
          data_policy: {
            ...model.endpoint.data_policy,
            training: true,
            retainsPrompts: true,
          },
        },
      };
    }),
  };
}
