import { addCacheBreakpoints } from '@/lib/ai-gateway/providers/openrouter/request-helpers';
import type { GatewayRequest } from '@/lib/ai-gateway/providers/openrouter/types';
import { normalizeToolCallIds } from '@/lib/ai-gateway/tool-calling';

function appendAnthropicBetaHeader(extraHeaders: Record<string, string>, betaFlag: string) {
  for (const header of ['anthropic-beta', 'x-anthropic-beta']) {
    extraHeaders[header] = [extraHeaders[header], betaFlag].filter(Boolean).join(',');
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

  // anthropic doesn't allow '.' in tool call ids
  if (requestToMutate.kind === 'chat_completions') {
    // we can fix this later for the responses api if it's still a problem
    normalizeToolCallIds(requestToMutate.body, toolCallId => toolCallId.includes('.'), undefined);
  }
}
