import type { OpenRouterChatCompletionRequest } from '@/lib/providers/openrouter/types';

export function isMoonshotModel(model: string) {
  return model.startsWith('moonshotai/');
}

export function applyMoonshotProviderSettings(requestToMutate: OpenRouterChatCompletionRequest) {
  // Moonshot models don't support the temperature parameter
  delete requestToMutate.temperature;
}
