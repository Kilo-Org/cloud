import type { OpenRouterChatCompletionRequest } from '@/lib/providers/openrouter/types';

export function isQwenModel(requestedModelId: string) {
  return requestedModelId.startsWith('qwen/');
}

export function applyQwenModelSettings(requestToMutate: OpenRouterChatCompletionRequest) {
  // Max Output listed on OpenRouter is wrong
  if (requestToMutate.max_tokens) {
    requestToMutate.max_tokens = Math.min(requestToMutate.max_tokens, 32768);
  }
  if (requestToMutate.max_completion_tokens) {
    requestToMutate.max_completion_tokens = Math.min(requestToMutate.max_completion_tokens, 32768);
  }
}
