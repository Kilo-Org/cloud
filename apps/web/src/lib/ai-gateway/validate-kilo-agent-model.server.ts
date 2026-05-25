import type { OpenRouterModel } from '@/lib/organizations/organization-types';

export function isKiloAgentModelAvailable(modelId: string, models: OpenRouterModel[]): boolean {
  return models.some(model => model.id === modelId);
}
