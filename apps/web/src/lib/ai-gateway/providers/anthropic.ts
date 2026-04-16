import { addCacheBreakpoints } from '@/lib/ai-gateway/providers/openrouter/request-helpers';
import type {
  GatewayRequest,
  OpenRouterChatCompletionRequest,
} from '@/lib/ai-gateway/providers/openrouter/types';
import { normalizeToolCallIds } from '@/lib/ai-gateway/tool-calling';

export function isAnthropicModel(requestedModel: string) {
  return requestedModel.startsWith('anthropic/');
}

export function isHaikuModel(requestedModel: string) {
  return requestedModel.startsWith('anthropic/claude-haiku');
}

function appendAnthropicBetaHeader(extraHeaders: Record<string, string>, betaFlag: string) {
  for (const header of ['anthropic-beta', 'x-anthropic-beta']) {
    extraHeaders[header] = [extraHeaders[header], betaFlag].filter(Boolean).join(',');
  }
}

// Anthropic does not accept a trailing assistant message through the chat_completions API path
// (the native Messages API does, as an assistant prefill, but some upstream routes reject it).
// Append a minimal placeholder user message so the request is valid.
export function appendPlaceholderUserMessageIfLastIsAssistant(
  request: OpenRouterChatCompletionRequest
) {
  const lastMessage = request.messages.at(-1);
  if (lastMessage?.role === 'assistant') {
    console.debug(
      '[appendPlaceholderUserMessageIfLastIsAssistant] appending placeholder user message'
    );
    request.messages.push({ role: 'user', content: 'Continue.' });
  }
}

export function applyAnthropicModelSettings(
  requestToMutate: GatewayRequest,
  extraHeaders: Record<string, string>
) {
  appendAnthropicBetaHeader(extraHeaders, 'fine-grained-tool-streaming-2025-05-14');

  // kilo-auto/frontier doesn't get cache breakpoints, because clients don't know it's a Claude model
  // additionally it is a common bug to forget adding cache breakpoints
  // we may want to gate this for Kilo-clients at some point
  addCacheBreakpoints(requestToMutate);

  if (requestToMutate.kind === 'chat_completions') {
    // anthropic doesn't allow '.' in tool call ids
    // we can fix this later for the responses api if it's still a problem
    normalizeToolCallIds(requestToMutate.body, toolCallId => toolCallId.includes('.'), undefined);
    appendPlaceholderUserMessageIfLastIsAssistant(requestToMutate.body);
  }
}
