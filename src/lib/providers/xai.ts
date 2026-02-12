import type { KiloFreeModel } from '@/lib/providers/kilo-free-model';
import type { OpenRouterChatCompletionRequest } from '@/lib/providers/openrouter/types';
import type { ProviderId } from '@/lib/providers/provider-id';

export const grok_code_fast_1_optimized_free_model = {
  public_id: 'x-ai/grok-code-fast-1:optimized:free',
  display_name: 'xAI: Grok Code Fast 1 Optimized (free)',
  description:
    'An optimized variant of Grok Code Fast 1, provided free of charge for a limited time. **Note:** All prompts and completions for this model are logged by the provider and may be used to improve their services.',
  context_length: 256_000,
  max_completion_tokens: 10_000,
  is_enabled: false,
  flags: ['reasoning', 'prompt_cache'],
  gateway: 'martian',
  internal_id: 'x-ai/grok-code-fast-1:optimized',
  inference_providers: ['stealth'],
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

  // https://kilo-code.slack.com/archives/C09922UFQHF/p1767968746782459
  extraHeaders['x-grok-conv-id'] = requestToMutate.prompt_cache_key || crypto.randomUUID();
  extraHeaders['x-grok-req-id'] = crypto.randomUUID();
}
