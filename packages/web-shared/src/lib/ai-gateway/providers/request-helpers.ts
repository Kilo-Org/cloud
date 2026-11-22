/**
 * Helpers that rewrite a request body for a provider that speaks a stricter
 * format than the OpenRouter body shape, so any provider family can use them.
 */
import type {
  GatewayRequest,
  OpenRouterChatCompletionRequest,
} from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/types';

export function removeChatCompletionsMessageNames(request: OpenRouterChatCompletionRequest) {
  for (const message of request.messages) {
    if ('name' in message) {
      delete message.name;
    }
  }
}

export function isReasoningExplicitlyDisabled(request: GatewayRequest) {
  if (request.kind === 'messages') {
    return request.body.thinking?.type === 'disabled';
  }
  if (request.kind === 'responses') {
    return request.body.reasoning?.effort === 'none';
  }
  if (request.body.reasoning?.enabled === true) {
    return false;
  }
  if (request.body.reasoning?.enabled === false) {
    return true;
  }
  return (
    (request.body.reasoning?.effort ?? request.body.reasoning_effort) === 'none' ||
    request.body.enable_thinking === false || // Alibaba
    request.body.thinking?.type === 'disabled' // Bytedance
  );
}

/**
 * Strict OpenAI-compatible upstreams reject OpenRouter's top-level `reasoning`
 * object as an unknown parameter, so its effort is carried over as the
 * standard `reasoning_effort` instead. `reasoning: { enabled: false }` maps to
 * `reasoning_effort: 'none'` only for upstreams that accept that value; others,
 * such as Chutes, reject it.
 */
export function replaceReasoningObjectWithReasoningEffort(
  request: GatewayRequest,
  { disableWithNoneEffort = false }: { disableWithNoneEffort?: boolean } = {}
) {
  if (request.kind !== 'chat_completions') {
    return;
  }
  const reasoning = request.body.reasoning;
  const reasoningEffort =
    reasoning?.effort ??
    (disableWithNoneEffort && reasoning?.enabled === false ? 'none' : undefined);
  if (reasoningEffort) {
    request.body.reasoning_effort ??= reasoningEffort;
  }
  delete request.body.reasoning;
}

/**
 * For Chat Completions upstreams that gate reasoning with a `thinking: { type }`
 * toggle and reject OpenRouter's top-level `reasoning` object: BytePlus, Z.ai,
 * and Kimi Code. The toggle mirrors an explicit client disable, and the
 * reasoning object is replaced because its `effort` has to reach those
 * upstreams as the standard `reasoning_effort` instead.
 */
export function applyThinkingToggleAndReasoningEffort(request: GatewayRequest) {
  if (request.kind !== 'chat_completions') {
    return;
  }
  request.body.thinking = {
    type: isReasoningExplicitlyDisabled(request) ? 'disabled' : 'enabled',
  };
  replaceReasoningObjectWithReasoningEffort(request);
}
