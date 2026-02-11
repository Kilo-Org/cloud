import type { KiloFreeModel } from '@/lib/providers/kilo-free-model';
import type { OpenRouterChatCompletionRequest } from '@/lib/providers/openrouter/types';
import type { ProviderId } from '@/lib/providers/provider-id';
import { hasAttemptCompletionTool } from '@/lib/tool-calling';

export const grok_code_fast_1_optimized_free_model = {
  public_id: 'x-ai/grok-code-fast-1:optimized:free',
  display_name: 'Grok Code Fast 1 optimized by Martian (free)',
  description:
    'A variant of Grok Code Fast 1 optimized by Martian, available for free in Kilo for a limited time.',
  context_length: 256_000,
  max_completion_tokens: 10_000,
  is_enabled: false,
  flags: ['reasoning', 'prompt_cache'],
  gateway: 'martian',
  internal_id: 'x-ai/grok-code-fast-1:optimized',
  inference_providers: ['martian'],
} as KiloFreeModel;

export function isXaiModel(requestedModel: string) {
  return requestedModel.startsWith('x-ai/');
}

export function applyXaiModelSettings(
  provider: ProviderId,
  requestToMutate: OpenRouterChatCompletionRequest,
  extraHeaders: Record<string, string>
) {
  if (provider === 'martian') {
    delete requestToMutate.provider;
  }

  if (hasAttemptCompletionTool(requestToMutate)) {
    requestToMutate.tool_choice = 'required';
  }

  // https://kilo-code.slack.com/archives/C09922UFQHF/p1767968746782459
  extraHeaders['x-grok-conv-id'] = requestToMutate.prompt_cache_key || crypto.randomUUID();
  extraHeaders['x-grok-req-id'] = crypto.randomUUID();
}
