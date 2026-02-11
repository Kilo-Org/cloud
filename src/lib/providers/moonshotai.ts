import type { OpenRouterChatCompletionRequest } from '@/lib/providers/openrouter/types';

export function isMoonshotModel(model: string) {
  return model.startsWith('moonshotai/');
}

export function applyMoonshotProviderSettings(requestToMutate: OpenRouterChatCompletionRequest) {
  // Moonshot models don't support the temperature parameter
  delete requestToMutate.temperature;

  // normalize reasoning setting; extension only allows setting reasoning effort
  const isReasoningEnabled =
    (requestToMutate.reasoning?.enabled ?? false) === true ||
    (requestToMutate.reasoning?.effort ?? 'none') !== 'none' ||
    (requestToMutate.reasoning?.max_tokens ?? 0) > 0;

  requestToMutate.reasoning = { enabled: isReasoningEnabled };
}
