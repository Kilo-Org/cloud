import type { OpenRouterModel } from '@/lib/ai-gateway/providers/openrouter/openrouter-types';

export function modelTrains(model: OpenRouterModel, providerTrains: boolean): boolean {
  return model.endpoint?.data_policy?.training ?? providerTrains;
}

export function modelRetainsPrompts(
  model: OpenRouterModel,
  providerRetainsPrompts: boolean
): boolean {
  return model.endpoint?.data_policy?.retainsPrompts ?? providerRetainsPrompts;
}
