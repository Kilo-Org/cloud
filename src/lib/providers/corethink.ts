import type { KiloFreeModel } from '@/lib/providers/kilo-free-model';
import type { OpenRouterChatCompletionRequest } from '@/lib/providers/openrouter/types';

export const corethink_free_model = {
  public_id: 'corethink:free',
  display_name: 'CoreThink (free)',
  description:
    'CoreThink - AI that reasons through problems instead of guessing. Available free of charge in Kilo for a limited time.',
  context_length: 78_000,
  max_completion_tokens: 8192,
  is_enabled: true,
  flags: [],
  gateway: 'corethink',
  internal_id: 'corethink',
  inference_providers: ['corethink'],
} as KiloFreeModel;

export function applyCoreThinkProviderSettings(requestToMutate: OpenRouterChatCompletionRequest) {
  delete requestToMutate.transforms;
  delete requestToMutate.prompt_cache_key;
  delete requestToMutate.safety_identifier;
  for (const message of requestToMutate.messages) {
    if ('reasoning' in message) {
      delete message.reasoning;
    }
    if ('reasoning_details' in message) {
      delete message.reasoning_details;
    }
  }
}
