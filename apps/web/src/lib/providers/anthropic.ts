import type { KiloExclusiveModel } from '@/lib/providers/kilo-exclusive-model';
import { addCacheBreakpoints } from '@/lib/providers/openrouter/request-helpers';
import type { GatewayRequest } from '@/lib/providers/openrouter/types';
import { normalizeToolCallIds } from '@/lib/tool-calling';

export const CLAUDE_SONNET_CURRENT_MODEL_ID = 'anthropic/claude-sonnet-4.6';

export const CLAUDE_SONNET_CURRENT_MODEL_NAME = 'Claude Sonnet 4.6';

export const CLAUDE_OPUS_CURRENT_MODEL_ID = 'anthropic/claude-opus-4.6';

export const CLAUDE_OPUS_CURRENT_MODEL_NAME = 'Claude Opus 4.6';

export const claude_sonnet_clawsetup_model: KiloExclusiveModel = {
  public_id: 'anthropic/claude-sonnet:clawsetup',
  internal_id: CLAUDE_SONNET_CURRENT_MODEL_NAME,
  display_name: 'Claude Sonnet KiloClaw Setup Promo',
  description: 'Claude Sonnet KiloClaw Setup Promo',
  status: 'hidden', // only usable through kilo-auto
  context_length: 1_000_000,
  max_completion_tokens: 128_000,
  gateway: 'openrouter',
  flags: ['reasoning', 'vision'],
  inference_provider: null,
  pricing: null,
};

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
