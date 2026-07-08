import type { OpenRouterModel } from '@/lib/ai-gateway/providers/openrouter/openrouter-types';

export function modelRetainsPrompts(
  model: OpenRouterModel,
  providerRetainsPrompts: boolean
): boolean {
  return model.endpoint?.data_policy?.retainsPrompts ?? providerRetainsPrompts;
}
