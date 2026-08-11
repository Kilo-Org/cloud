import * as z from 'zod';
import type OpenAI from 'openai';
import type Anthropic from '@anthropic-ai/sdk';
import { createParser } from 'eventsource-parser';
import type { GatewayRequest } from '@/lib/ai-gateway/providers/openrouter/types';

export const toolCallArgumentErrorSchema = z.discriminatedUnion('kind', [
  z.object({
    tool_call_id: z.string(),
    tool_name: z.string(),
    kind: z.literal('unparseable_json'),
    details: z.string(),
  }),
  z.object({
    tool_call_id: z.string(),
    tool_name: z.string(),
    kind: z.literal('schema_mismatch'),
    details: z.unknown(),
  }),
  z.object({
    tool_call_id: z.string(),
    tool_name: z.string(),
    kind: z.literal('unknown_tool'),
  }),
]);

export const apiRequestLogErrorSchema = z.object({
  invalid_tool_call_arguments: z.array(toolCallArgumentErrorSchema).optional(),
  upstream_error: z.unknown().optional(),
  response_body_read_error: z.string().optional(),
});

export type ApiRequestLogError = z.infer<typeof apiRequestLogErrorSchema>;

type ToolCallError = z.infer<typeof toolCallArgumentErrorSchema>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function checkKnownTool(
  knownToolNames: Set<string>,
  toolCallId: string,
  toolName: string,
  errors: ToolCallError[]
): boolean {
  if (knownToolNames.has(toolName)) return true;
  errors.push({
    tool_call_id: toolCallId,
    tool_name: toolName,
    kind: 'unknown_tool',
  });
  return false;
}

function validateAgainstSchema(
  parsedArgs: unknown,
  parameters: unknown,
  toolCallId: string,
  toolName: string,
  errors: ToolCallError[]
): void {
  if (parameters == null) return;
  let zodSchema: ReturnType<typeof z.fromJSONSchema>;
  try {
    zodSchema = z.fromJSONSchema(parameters as Parameters<typeof z.fromJSONSchema>[0]);
  } catch {
    // Unsupported schema features — skip validation for this tool
    return;
  }
  const result = zodSchema.safeParse(parsedArgs);
  if (!result.success) {
    errors.push({
      tool_call_id: toolCallId,
      tool_name: toolName,
      kind: 'schema_mismatch',
      details: z.treeifyError(result.error),
    });
  }
}

function parseArgsString(
  argsStr: string,
  toolCallId: string,
  toolName: string,
  errors: ToolCallError[]
): { parsed: unknown; ok: true } | { ok: false } {
  try {
    return { parsed: JSON.parse(argsStr), ok: true };
  } catch (e) {
    errors.push({
      tool_call_id: toolCallId,
      tool_name: toolName,
      kind: 'unparseable_json',
      details: e instanceof Error ? e.message : String(e),
    });
    return { ok: false };
  }
}

/**
 * Returns the JSON payload strings from SSE `data:` events, excluding `[DONE]`.
 * Returns an empty array if the text does not look like an SSE stream.
 */
function parseSseDataLines(text: string): string[] {
  const payloads: string[] = [];
  const parser = createParser({
    onEvent(event) {
      if (event.data !== '[DONE]') payloads.push(event.data);
    },
  });
  parser.feed(text);
  return payloads;
}

function parseJsonLine(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}

function extractUpstreamError(value: unknown): unknown {
  if (!isRecord(value)) return undefined;
  if (value.error != null) return value.error;
  if (
    value.type === 'response.failed' &&
    isRecord(value.response) &&
    value.response.error != null
  ) {
    return value.response.error;
  }
  return undefined;
}

function lastUpstreamError(values: unknown[]): unknown {
  let found: unknown = undefined;
  for (const value of values) {
    const error = extractUpstreamError(value);
    if (error !== undefined) found = error;
  }
  return found;
}

function buildError(
  toolErrors: ToolCallError[],
  upstreamError: unknown
): ApiRequestLogError | null {
  if (toolErrors.length === 0 && upstreamError === undefined) return null;
  return {
    ...(toolErrors.length > 0 ? { invalid_tool_call_arguments: toolErrors } : {}),
    ...(upstreamError !== undefined ? { upstream_error: upstreamError } : {}),
  };
}

type ToolAccumulator = { id: string; name: string; arguments: string };

function detectChatCompletionSseErrors(
  lines: string[],
  tools: OpenAI.Chat.ChatCompletionTool[] | null | undefined
): ToolCallError[] {
  const toolSchemaByName = new Map<string, unknown>();
  const knownToolNames = new Set<string>();
  for (const tool of tools ?? []) {
    if (tool.type === 'function') {
      knownToolNames.add(tool.function.name);
      toolSchemaByName.set(tool.function.name, tool.function.parameters);
    }
  }

  // Accumulate tool call arguments by index across chunks (choice 0 only)
  const byIndex = new Map<number, ToolAccumulator>();
  for (const line of lines) {
    const chunk = parseJsonLine(line);
    if (!isRecord(chunk) || !Array.isArray(chunk.choices)) continue;
    const choice = chunk.choices.find(
      (item): item is Record<string, unknown> => isRecord(item) && item.index === 0
    );
    const delta = isRecord(choice?.delta) ? choice.delta : undefined;
    if (!Array.isArray(delta?.tool_calls)) continue;
    for (const toolCall of delta.tool_calls) {
      if (!isRecord(toolCall) || typeof toolCall.index !== 'number') continue;
      const fn = isRecord(toolCall.function) ? toolCall.function : undefined;
      const acc = byIndex.get(toolCall.index) ?? { id: '', name: '', arguments: '' };
      if (typeof toolCall.id === 'string') acc.id = toolCall.id;
      if (typeof fn?.name === 'string') acc.name = fn.name;
      if (typeof fn?.arguments === 'string') acc.arguments += fn.arguments;
      byIndex.set(toolCall.index, acc);
    }
  }

  const errors: ToolCallError[] = [];
  for (const [, acc] of byIndex) {
    if (!acc.name) continue;
    if (!checkKnownTool(knownToolNames, acc.id, acc.name, errors)) continue;
    const result = parseArgsString(acc.arguments, acc.id, acc.name, errors);
    if (result.ok) {
      validateAgainstSchema(
        result.parsed,
        toolSchemaByName.get(acc.name),
        acc.id,
        acc.name,
        errors
      );
    }
  }
  return errors;
}

function detectResponsesSseErrors(
  lines: string[],
  tools: OpenAI.Responses.ResponseCreateParams['tools']
): ToolCallError[] {
  const toolSchemaByName = new Map<string, unknown>();
  const knownToolNames = new Set<string>();
  for (const tool of tools ?? []) {
    if (tool.type === 'function') {
      knownToolNames.add(tool.name);
      toolSchemaByName.set(tool.name, tool.parameters);
    }
  }

  // response.output_item.done carries the fully assembled function_call item
  const errors: ToolCallError[] = [];
  for (const line of lines) {
    const event = parseJsonLine(line);
    if (!isRecord(event) || event.type !== 'response.output_item.done') continue;
    const item = event.item;
    if (!isRecord(item) || item.type !== 'function_call') continue;
    if (typeof item.call_id !== 'string' || typeof item.name !== 'string') continue;
    const argsStr = typeof item.arguments === 'string' ? item.arguments : '';
    if (!checkKnownTool(knownToolNames, item.call_id, item.name, errors)) continue;
    const result = parseArgsString(argsStr, item.call_id, item.name, errors);
    if (result.ok) {
      validateAgainstSchema(
        result.parsed,
        toolSchemaByName.get(item.name),
        item.call_id,
        item.name,
        errors
      );
    }
  }
  return errors;
}

function detectMessagesSseErrors(
  lines: string[],
  tools: Anthropic.MessageCreateParams['tools']
): ToolCallError[] {
  const toolSchemaByName = new Map<string, unknown>();
  const knownToolNames = new Set<string>();
  for (const tool of tools ?? []) {
    knownToolNames.add(tool.name);
    // Anthropic.Tool has input_schema; server tools (BashTool, TextEditorTool, etc.) do not
    if ('input_schema' in tool) {
      toolSchemaByName.set(tool.name, tool.input_schema);
    }
  }

  // Accumulate partial_json fragments by content block index
  const byIndex = new Map<number, ToolAccumulator>();
  for (const line of lines) {
    const event = parseJsonLine(line);
    if (!isRecord(event)) continue;
    if (event.type === 'content_block_start' && isRecord(event.content_block)) {
      if (event.content_block.type !== 'tool_use') continue;
      if (typeof event.index !== 'number') continue;
      const id = typeof event.content_block.id === 'string' ? event.content_block.id : '';
      const name = typeof event.content_block.name === 'string' ? event.content_block.name : '';
      byIndex.set(event.index, { id, name, arguments: '' });
    } else if (event.type === 'content_block_delta' && isRecord(event.delta)) {
      if (event.delta.type !== 'input_json_delta') continue;
      if (typeof event.index !== 'number') continue;
      const acc = byIndex.get(event.index);
      if (acc && typeof event.delta.partial_json === 'string') {
        acc.arguments += event.delta.partial_json;
      }
    }
  }

  const errors: ToolCallError[] = [];
  for (const [, acc] of byIndex) {
    if (!checkKnownTool(knownToolNames, acc.id, acc.name, errors)) continue;
    const result = parseArgsString(acc.arguments, acc.id, acc.name, errors);
    if (result.ok) {
      validateAgainstSchema(
        result.parsed,
        toolSchemaByName.get(acc.name),
        acc.id,
        acc.name,
        errors
      );
    }
  }
  return errors;
}

function detectChatCompletionJsonErrors(
  response: unknown,
  tools: OpenAI.Chat.ChatCompletionTool[] | null | undefined
): ToolCallError[] {
  if (!isRecord(response) || !Array.isArray(response.choices)) return [];

  const toolSchemaByName = new Map<string, unknown>();
  const knownToolNames = new Set<string>();
  for (const tool of tools ?? []) {
    if (tool.type === 'function') {
      knownToolNames.add(tool.function.name);
      toolSchemaByName.set(tool.function.name, tool.function.parameters);
    }
  }

  const errors: ToolCallError[] = [];
  for (const choice of response.choices) {
    if (
      !isRecord(choice) ||
      !isRecord(choice.message) ||
      !Array.isArray(choice.message.tool_calls)
    ) {
      continue;
    }
    for (const toolCall of choice.message.tool_calls) {
      if (!isRecord(toolCall) || toolCall.type !== 'function' || !isRecord(toolCall.function)) {
        continue;
      }
      const id = typeof toolCall.id === 'string' ? toolCall.id : '';
      const name = typeof toolCall.function.name === 'string' ? toolCall.function.name : '';
      if (!name) continue;
      if (!checkKnownTool(knownToolNames, id, name, errors)) continue;
      const argsStr =
        typeof toolCall.function.arguments === 'string' ? toolCall.function.arguments : '';
      const result = parseArgsString(argsStr, id, name, errors);
      if (result.ok) {
        validateAgainstSchema(result.parsed, toolSchemaByName.get(name), id, name, errors);
      }
    }
  }
  return errors;
}

function detectResponsesJsonErrors(
  response: unknown,
  tools: OpenAI.Responses.ResponseCreateParams['tools']
): ToolCallError[] {
  if (!isRecord(response) || !Array.isArray(response.output)) return [];

  const toolSchemaByName = new Map<string, unknown>();
  const knownToolNames = new Set<string>();
  for (const tool of tools ?? []) {
    if (tool.type === 'function') {
      knownToolNames.add(tool.name);
      toolSchemaByName.set(tool.name, tool.parameters);
    }
  }

  const errors: ToolCallError[] = [];
  for (const item of response.output) {
    if (!isRecord(item) || item.type !== 'function_call') continue;
    const callId = typeof item.call_id === 'string' ? item.call_id : '';
    const name = typeof item.name === 'string' ? item.name : '';
    if (!name) continue;
    if (!checkKnownTool(knownToolNames, callId, name, errors)) continue;
    const argsStr = typeof item.arguments === 'string' ? item.arguments : '';
    const result = parseArgsString(argsStr, callId, name, errors);
    if (result.ok) {
      validateAgainstSchema(result.parsed, toolSchemaByName.get(name), callId, name, errors);
    }
  }
  return errors;
}

function detectMessagesJsonErrors(
  response: unknown,
  tools: Anthropic.MessageCreateParams['tools']
): ToolCallError[] {
  if (!isRecord(response) || !Array.isArray(response.content)) return [];

  const toolSchemaByName = new Map<string, unknown>();
  const knownToolNames = new Set<string>();
  for (const tool of tools ?? []) {
    knownToolNames.add(tool.name);
    if ('input_schema' in tool) {
      toolSchemaByName.set(tool.name, tool.input_schema);
    }
  }

  const errors: ToolCallError[] = [];
  for (const block of response.content) {
    if (!isRecord(block) || block.type !== 'tool_use') continue;
    const id = typeof block.id === 'string' ? block.id : '';
    const name = typeof block.name === 'string' ? block.name : '';
    if (!name) continue;
    if (!checkKnownTool(knownToolNames, id, name, errors)) continue;
    validateAgainstSchema(block.input, toolSchemaByName.get(name), id, name, errors);
  }
  return errors;
}

function detectSseErrors(lines: string[], request: GatewayRequest): ApiRequestLogError | null {
  const events = lines.map(parseJsonLine).filter(value => value !== undefined);
  const toolErrors =
    request.kind === 'chat_completions'
      ? detectChatCompletionSseErrors(lines, request.body.tools)
      : request.kind === 'responses'
        ? detectResponsesSseErrors(lines, request.body.tools)
        : detectMessagesSseErrors(lines, request.body.tools);
  return buildError(toolErrors, lastUpstreamError(events));
}

function detectJsonErrors(
  responseText: string,
  request: GatewayRequest
): ApiRequestLogError | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(responseText);
  } catch {
    return null;
  }

  const toolErrors =
    request.kind === 'chat_completions'
      ? detectChatCompletionJsonErrors(parsed, request.body.tools)
      : request.kind === 'responses'
        ? detectResponsesJsonErrors(parsed, request.body.tools)
        : detectMessagesJsonErrors(parsed, request.body.tools);
  return buildError(toolErrors, extractUpstreamError(parsed));
}

/**
 * Extracts structured details for `api_request_log.error` from an upstream
 * response body. Covers SSE and non-streamed JSON: invalid tool-call
 * arguments and provider error objects.
 */
export function detectRequestLogErrors(
  responseText: string,
  request: GatewayRequest
): ApiRequestLogError | null {
  const lines = parseSseDataLines(responseText);
  if (lines.length > 0) return detectSseErrors(lines, request);
  return detectJsonErrors(responseText, request);
}
