import type { OpenRouterChatCompletionRequest } from '@/lib/ai-gateway/providers/openrouter/types';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Recursively rewrites every JSON Schema `oneOf` keyword as `anyOf`, mutating
 * the schema in place. Friendli does not support `oneOf`, so requests routed to
 * it must downgrade those keywords to the `anyOf` Friendli understands.
 *
 * Cycles are guarded against with a visited set so recursive or circular
 * schemas cannot loop forever.
 */
function rewriteOneOfAsAnyOf(schema: unknown): void {
  if (!isRecord(schema)) return;

  const pending: Record<string, unknown>[] = [schema];
  const visited = new WeakSet<object>();

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
      }
      if (isRecord(nestedValue)) {
        pending.push(nestedValue);
      }
    }
  }
}

/**
 * Rewrites all `oneOf` keywords as `anyOf` in the JSON Schemas attached to a
 * chat completions request — both tool function `parameters` and the
 * `response_format.json_schema.schema`.
 */
export function rewriteChatCompletionsOneOfAsAnyOf(
  request: OpenRouterChatCompletionRequest
): void {
  if (Array.isArray(request.tools)) {
    for (const tool of request.tools) {
      if (!isRecord(tool) || tool.type !== 'function' || !isRecord(tool.function)) continue;
      rewriteOneOfAsAnyOf(tool.function.parameters);
    }
  }

  const responseFormat = request.response_format;
  if (
    isRecord(responseFormat) &&
    responseFormat.type === 'json_schema' &&
    isRecord(responseFormat.json_schema)
  ) {
    rewriteOneOfAsAnyOf(responseFormat.json_schema.schema);
  }
}
