import type {
  NormalizedOpenRouterResponse,
  OpenRouterModel,
} from '@/lib/ai-gateway/providers/openrouter/openrouter-types';

export type ModelDataPolicy = {
  providerSlug: string;
  training: boolean;
  retainsPrompts: boolean;
};

export function buildModelDataPolicies(
  snapshot: NormalizedOpenRouterResponse | undefined,
  getModelVariantId: (model: OpenRouterModel) => string
): ReadonlyMap<string, readonly ModelDataPolicy[]> {
  const policies = new Map<string, ModelDataPolicy[]>();
  for (const provider of snapshot?.providers ?? []) {
    for (const model of provider.models) {
      const modelId = getModelVariantId(model);
      const normalizedModel = withWorstProviderDataPolicy(model, provider.dataPolicy);
      const policy = {
        providerSlug: provider.slug,
        training: modelTrains(normalizedModel, provider.dataPolicy.training),
        retainsPrompts: modelRetainsPrompts(normalizedModel, provider.dataPolicy.retainsPrompts),
      };
      const existing = policies.get(modelId);
      if (existing) existing.push(policy);
      else policies.set(modelId, [policy]);
    }
  }
  return policies;
}

/**
 * OpenRouter returns one route per model even when a provider offers routes with different data
 * policies. Report data collection if either that route or the provider-wide policy allows it.
 */
export function withWorstProviderDataPolicy(
  model: OpenRouterModel,
  providerPolicy: { training: boolean; retainsPrompts: boolean }
): OpenRouterModel {
  if (!model.endpoint) return model;

  return {
    ...model,
    endpoint: {
      ...model.endpoint,
      data_policy: {
        training: providerPolicy.training || model.endpoint.data_policy?.training === true,
        retainsPrompts:
          providerPolicy.retainsPrompts || model.endpoint.data_policy?.retainsPrompts === true,
      },
    },
  };
}

export function modelTrains(model: OpenRouterModel, providerTrains: boolean): boolean {
  return model.endpoint?.data_policy?.training ?? providerTrains;
}

export function modelRetainsPrompts(
  model: OpenRouterModel,
  providerRetainsPrompts: boolean
): boolean {
  return model.endpoint?.data_policy?.retainsPrompts ?? providerRetainsPrompts;
}
