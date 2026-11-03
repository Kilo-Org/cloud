import 'server-only';

import {
  GEMMA_4_26B_A4B_IT_FREE_ID,
  GEMMA_4_26B_A4B_IT_ID,
} from '@kilocode/web-shared/lib/ai-gateway/providers/google';
import type { GatewayRequest } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/types';

/**
 * The model `kilo-auto/small` routes users without balance to. Direct requests
 * for it are rejected as unavailable. Kilo pays to serve it as the paid model,
 * so it stays on Kilo's own accounts and never uses a user's BYOK key.
 */
export function isAutoSmallFreeModel(model: string): boolean {
  return model === GEMMA_4_26B_A4B_IT_FREE_ID;
}

export function autoSmallFreeModelUpstreamId(model: string): string {
  return isAutoSmallFreeModel(model) ? GEMMA_4_26B_A4B_IT_ID : model;
}

export const AUTO_SMALL_FREE_MODEL_CONTEXT_LENGTH = 262144;

const MAX_COMPLETION_TOKENS = 32768;

type TokenLimitMutation = 'removed' | 'clamped';

function logMaxTokenMutation(
  requestToMutate: GatewayRequest,
  field: 'max_completion_tokens' | 'max_tokens' | 'max_output_tokens',
  requestedValue: number,
  mutation: TokenLimitMutation
) {
  console.warn('[removeNonSensicalMaxTokens] mutated request with token limit above model cap', {
    model: GEMMA_4_26B_A4B_IT_FREE_ID,
    requestKind: requestToMutate.kind,
    field,
    requestedValue,
    modelMaxCompletionTokens: MAX_COMPLETION_TOKENS,
    mutation,
  });
}

function removeNonSensicalMaxTokens(requestToMutate: GatewayRequest) {
  // OpenClaw sometimes puts numbers in that are too large and some providers will reject the request.
  if (requestToMutate.kind === 'chat_completions') {
    const maxCompletionTokens = requestToMutate.body.max_completion_tokens;
    if (
      maxCompletionTokens !== undefined &&
      maxCompletionTokens !== null &&
      maxCompletionTokens > MAX_COMPLETION_TOKENS
    ) {
      logMaxTokenMutation(requestToMutate, 'max_completion_tokens', maxCompletionTokens, 'removed');
      delete requestToMutate.body.max_completion_tokens;
    }

    const maxTokens = requestToMutate.body.max_tokens;
    if (maxTokens !== undefined && maxTokens > MAX_COMPLETION_TOKENS) {
      logMaxTokenMutation(requestToMutate, 'max_tokens', maxTokens, 'removed');
      delete requestToMutate.body.max_tokens;
    }
  }
  if (requestToMutate.kind === 'responses') {
    const maxOutputTokens = requestToMutate.body.max_output_tokens;
    if (
      maxOutputTokens !== undefined &&
      maxOutputTokens !== null &&
      maxOutputTokens > MAX_COMPLETION_TOKENS
    ) {
      logMaxTokenMutation(requestToMutate, 'max_output_tokens', maxOutputTokens, 'removed');
      delete requestToMutate.body.max_output_tokens;
    }
  }
  if (requestToMutate.kind === 'messages') {
    const maxTokens = requestToMutate.body.max_tokens;
    if (maxTokens !== undefined && maxTokens > MAX_COMPLETION_TOKENS) {
      logMaxTokenMutation(requestToMutate, 'max_tokens', maxTokens, 'clamped');
      requestToMutate.body.max_tokens = MAX_COMPLETION_TOKENS;
    }
  }
}

/** Rewrites a gateway request for the auto small free model to target the paid model. */
export function applyAutoSmallFreeModelSettings(requestToMutate: GatewayRequest) {
  requestToMutate.body.model = GEMMA_4_26B_A4B_IT_ID;
  removeNonSensicalMaxTokens(requestToMutate);
}
