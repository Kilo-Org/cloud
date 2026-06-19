import type {
  GatewayRequest,
  OpenRouterChatCompletionRequest,
} from '@/lib/ai-gateway/providers/openrouter/types';
import { OpenRouterInferenceProviderIdSchema } from '@/lib/ai-gateway/providers/openrouter/inference-provider-id';
import { warnExceptInTest } from '@/lib/utils.server';

export type FriendliChatCompletionsRequest = {
  kind: 'chat_completions';
  body: OpenRouterChatCompletionRequest;
};

type OneOfRewriteLogDetails = {
  event: 'ai_gateway_chat_completions_one_of_rewritten';
  model: string;
  count: number;
  toolNames: string[];
};

type OneOfRewriteLogger = (message: string, details: OneOfRewriteLogDetails) => void;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Whether a gateway request is a chat completions request routed through the
 * Friendli inference provider (i.e. `friendli` appears in `provider.order`).
 * Friendli does not support JSON Schema `oneOf`, so such requests need
 * rewriting before they are forwarded.
 */
export function isFriendliChatCompletionsRequest(
  request: GatewayRequest
): request is FriendliChatCompletionsRequest {
  if (request.kind !== 'chat_completions') return false;
  const order = request.body.provider?.order;
  return Array.isArray(order) && order.includes(OpenRouterInferenceProviderIdSchema.enum.friendli);
}

/**
 * Recursively rewrites every JSON Schema `oneOf` keyword as `anyOf`, mutating
 * the schema in place. Friendli does not support `oneOf`, so requests routed to
 * it must downgrade those keywords to the `anyOf` Friendli understands.
 *
 * Cycles are guarded against with a visited set so recursive or circular
 * schemas cannot loop forever. Returns the number of `oneOf` keywords removed.
 */
function rewriteOneOfAsAnyOf(schema: unknown): number {
  if (!isRecord(schema)) return 0;

  const pending: Record<string, unknown>[] = [schema];
  const visited = new WeakSet<object>();
  let rewritten = 0;

  while (pending.length > 0) {
    const value = pending.pop();
    if (!value || visited.has(value)) continue;
    visited.add(value);

    for (const [key, nestedValue] of Object.entries(value)) {
      if (key === 'oneOf') {
        const oneOf = value.oneOf;
        delete value.oneOf;
        if (Array.isArray(oneOf)) {
          const existingAnyOf = Array.isArray(value.anyOf) ? value.anyOf : [];
          value.anyOf = [...existingAnyOf, ...oneOf];
        }
        rewritten += 1;
      }
      if (isRecord(nestedValue)) {
        pending.push(nestedValue);
      }
    }
  }

  return rewritten;
}

/**
 * Rewrites all `oneOf` keywords as `anyOf` in the JSON Schemas attached to a
 * chat completions request — both tool function `parameters` and the
 * `response_format.json_schema.schema`. Logs once per request, but only when at
 * least one `oneOf` was actually rewritten.
 */
export function rewriteChatCompletionsOneOfAsAnyOf(
  request: OpenRouterChatCompletionRequest,
  log: OneOfRewriteLogger = warnExceptInTest
): void {
  let rewritten = 0;
  const toolNames = new Set<string>();

  if (Array.isArray(request.tools)) {
    for (const tool of request.tools) {
      if (!isRecord(tool) || tool.type !== 'function' || !isRecord(tool.function)) continue;
      const toolRewritten = rewriteOneOfAsAnyOf(tool.function.parameters);
      rewritten += toolRewritten;
      if (toolRewritten > 0 && typeof tool.function.name === 'string') {
        toolNames.add(tool.function.name);
      }
    }
  }

  const responseFormat = request.response_format;
  if (
    isRecord(responseFormat) &&
    responseFormat.type === 'json_schema' &&
    isRecord(responseFormat.json_schema)
  ) {
    rewritten += rewriteOneOfAsAnyOf(responseFormat.json_schema.schema);
  }

  if (rewritten === 0) return;

  log('Rewrote JSON Schema oneOf as anyOf for Friendli', {
    event: 'ai_gateway_chat_completions_one_of_rewritten',
    model: request.model,
    count: rewritten,
    toolNames: [...toolNames],
  });
}
