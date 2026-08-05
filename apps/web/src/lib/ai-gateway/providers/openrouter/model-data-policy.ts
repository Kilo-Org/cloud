import type { OpenRouterModel } from '@/lib/ai-gateway/providers/openrouter/openrouter-types';

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
