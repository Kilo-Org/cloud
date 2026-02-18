import { ReasoningDetailType } from '@/lib/custom-llm/reasoning-details';
import type {
  MessageWithReasoning,
  OpenRouterChatCompletionRequest,
} from '@/lib/providers/openrouter/types';
import type { ProviderId } from '@/lib/providers/provider-id';

export function isXaiModel(requestedModel: string) {
  return requestedModel.startsWith('x-ai/');
}

export function applyXaiModelSettings(
  provider: ProviderId,
  requestToMutate: OpenRouterChatCompletionRequest,
  extraHeaders: Record<string, string>
) {
  if (provider === 'martian') {
    delete requestToMutate.description;
    delete requestToMutate.provider;
    delete requestToMutate.usage;
    delete requestToMutate.transforms;
    delete requestToMutate.reasoningEffort;

    for (const message of requestToMutate.messages) {
      if (message.role !== 'assistant') {
        continue;
      }
      const msgWithReasoning = message as MessageWithReasoning;
      const reasoningDetailsText = (msgWithReasoning.reasoning_details ?? [])
        .filter(r => r.type === ReasoningDetailType.Text)
        .map(r => r.text)
        .join('');
      if (reasoningDetailsText) {
        msgWithReasoning.reasoning_content = reasoningDetailsText;
        delete msgWithReasoning.reasoning_details;
        delete msgWithReasoning.reasoning;
      }
    }
  }

  // https://kilo-code.slack.com/archives/C09922UFQHF/p1767968746782459
  extraHeaders['x-grok-conv-id'] = requestToMutate.prompt_cache_key || crypto.randomUUID();
  extraHeaders['x-grok-req-id'] = crypto.randomUUID();
}
