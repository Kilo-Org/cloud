import type { KiloFreeModel } from '@/lib/providers/kilo-free-model';
import type { OpenRouterChatCompletionRequest } from '@/lib/providers/openrouter/types';
import {
  dropToolStrictProperties,
  hasAttemptCompletionTool,
  normalizeToolCallIds,
} from '@/lib/tool-calling';

export const devstral_small_2512_free_model = {
  public_id: 'mistralai/devstral-small-2512:free',
  display_name: 'Mistral: Devstral Small 2 2512 (free)',
  description:
    'Devstral Small 2 is a state-of-the-art open-source model by Mistral AI specializing in agentic coding. It is a 24B-parameter dense transformer model supporting a 256K context window.\n**Note:** prompts and completions may be logged by Mistral during the free period and used to improve the model.',
  context_length: 262144,
  max_completion_tokens: 262144,
  is_enabled: false,
  flags: [],
  gateway: 'vercel',
  internal_id: 'mistral/devstral-small-2',
  inference_providers: ['mistral'],
} as KiloFreeModel;

export function isMistralModel(model: string) {
  return model.startsWith('mistralai/');
}

export function applyMistralModelSettings(requestToMutate: OpenRouterChatCompletionRequest) {
  // mistral recommends this
  // https://kilo-code.slack.com/archives/C09PV151JMN/p1764597849596819
  if (requestToMutate.temperature === undefined) {
    requestToMutate.temperature = 0.2;
  }

  // mistral requires tool call ids to be of length 9
  normalizeToolCallIds(requestToMutate, 9);

  // mistral doesn't support strict for our schema
  dropToolStrictProperties(requestToMutate);

  if (hasAttemptCompletionTool(requestToMutate)) {
    requestToMutate.tool_choice = 'required';
  }
}

export function applyMistralProviderSettings(
  requestToMutate: OpenRouterChatCompletionRequest,
  extraHeaders: Record<string, string>
) {
  // https://kilo-code.slack.com/archives/C09PV151JMN/p1764256100573969?thread_ts=1764179992.347349&cid=C09PV151JMN
  if (requestToMutate.prompt_cache_key) {
    extraHeaders['x-affinity'] = requestToMutate.prompt_cache_key;
  }

  // the stuff below is not supported by mistral and causes an error
  for (const message of requestToMutate.messages) {
    if ('reasoning_details' in message) {
      delete message.reasoning_details;
    }
  }
  delete requestToMutate.reasoning;
  delete requestToMutate.reasoning_effort;
  delete requestToMutate.transforms;
  delete requestToMutate.safety_identifier;
  delete requestToMutate.prompt_cache_key;
  delete requestToMutate.user;
  delete requestToMutate.provider;

  applyMistralModelSettings(requestToMutate);
}
