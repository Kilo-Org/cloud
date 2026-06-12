import type { OpenRouterChatCompletionRequest } from '@/lib/ai-gateway/providers/openrouter/types';
import type { ProviderId } from '@/lib/ai-gateway/providers/types';
import { warnExceptInTest } from '@/lib/utils.server';

type OneOfSchemaLogDetails = {
  event: 'ai_gateway_chat_completions_one_of_schema';
  model: string;
  provider: ProviderId;
  one_of_occurrences: number;
  tool_schema_count: number;
  response_format_schema: boolean;
};

type OneOfSchemaLogger = (message: string, details: OneOfSchemaLogDetails) => void;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function countOneOfOccurrences(schema: unknown): number {
  if (typeof schema !== 'object' || schema === null) return 0;

  const pending: object[] = [schema];
  const visited = new WeakSet<object>();
  let occurrences = 0;

  while (pending.length > 0) {
    const value = pending.pop();
    if (!value || visited.has(value)) continue;
    visited.add(value);

    for (const [key, nestedValue] of Object.entries(value)) {
      if (key === 'oneOf') occurrences += 1;
      if (typeof nestedValue === 'object' && nestedValue !== null) {
        pending.push(nestedValue);
      }
    }
  }

  return occurrences;
}

export function logChatCompletionsOneOfSchemas(
  request: OpenRouterChatCompletionRequest,
  model: string,
  provider: ProviderId,
  log: OneOfSchemaLogger = warnExceptInTest
): void {
  let oneOfOccurrences = 0;
  let toolSchemaCount = 0;

  if (Array.isArray(request.tools)) {
    for (const tool of request.tools) {
      if (!isRecord(tool) || tool.type !== 'function' || !isRecord(tool.function)) continue;

      const occurrences = countOneOfOccurrences(tool.function.parameters);
      if (occurrences === 0) continue;

      oneOfOccurrences += occurrences;
      toolSchemaCount += 1;
    }
  }

  let responseFormatSchema = false;
  const responseFormat = request.response_format;
  if (
    isRecord(responseFormat) &&
    responseFormat.type === 'json_schema' &&
    isRecord(responseFormat.json_schema)
  ) {
    const occurrences = countOneOfOccurrences(responseFormat.json_schema.schema);
    if (occurrences > 0) {
      oneOfOccurrences += occurrences;
      responseFormatSchema = true;
    }
  }

  if (oneOfOccurrences === 0) return;

  log('Chat completions request contains JSON Schema oneOf', {
    event: 'ai_gateway_chat_completions_one_of_schema',
    model,
    provider,
    one_of_occurrences: oneOfOccurrences,
    tool_schema_count: toolSchemaCount,
    response_format_schema: responseFormatSchema,
  });
}
