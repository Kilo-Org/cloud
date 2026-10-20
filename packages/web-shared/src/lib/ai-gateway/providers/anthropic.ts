import { addCacheBreakpoints } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/request-helpers';
import type { GatewayRequest } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/types';
import { normalizeToolCallIds } from '@kilocode/web-shared/lib/ai-gateway/tool-calling';

const ANTHROPIC_TOOL_CALL_ID_PATTERN = /^[a-zA-Z0-9_-]{1,128}$/;

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

  normalizeToolCallIds(
    requestToMutate,
    toolCallId => !ANTHROPIC_TOOL_CALL_ID_PATTERN.test(toolCallId),
    undefined
  );
}
