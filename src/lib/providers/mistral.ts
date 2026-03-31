import type { GatewayRequest } from '@/lib/providers/openrouter/types';
import {
  dropToolStrictProperties,
  hasAttemptCompletionTool,
  normalizeToolCallIds,
} from '@/lib/tool-calling';

export function isMistralModel(model: string) {
  return model.startsWith('mistralai/');
}
export function isCodestralModel(model: string) {
  return model.startsWith('mistralai/codestral');
}

export function applyMistralModelSettings(requestToMutate: GatewayRequest) {
  if (requestToMutate.kind !== 'chat_completions') {
    return;
  }

  // mistral recommends this
  // https://kilo-code.slack.com/archives/C09PV151JMN/p1764597849596819
  if (requestToMutate.body.temperature === undefined) {
    requestToMutate.body.temperature = 0.2;
  }

  // mistral requires tool call ids to be of length 9
  normalizeToolCallIds(requestToMutate.body, toolCallId => toolCallId.length !== 9, 9);

  // mistral doesn't support strict for our schema
  dropToolStrictProperties(requestToMutate.body);

  if (hasAttemptCompletionTool(requestToMutate.body)) {
    requestToMutate.body.tool_choice = 'required';
  }
}
