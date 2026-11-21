import type { GatewayRequest } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/types';
import { normalizeToolCallIds } from '@kilocode/web-shared/lib/ai-gateway/tool-calling';

const OPENAI_MAX_TOOL_CALL_ID_LENGTH = 64;

export function isOpenAiModel(requestedModel: string) {
  return (
    (requestedModel.includes('openai') || requestedModel.includes('gpt')) &&
    !isGptOssModel(requestedModel)
  );
}

export function isGptOssModel(requestedModel: string) {
  return requestedModel.includes('gpt-oss');
}

export function applyOpenAiModelSettings(requestToMutate: GatewayRequest) {
  // OpenAI rejects tool call ids longer than 64 characters with string_above_max_length
  normalizeToolCallIds(
    requestToMutate,
    toolCallId =>
      typeof toolCallId === 'string' && toolCallId.length > OPENAI_MAX_TOOL_CALL_ID_LENGTH
  );
}
