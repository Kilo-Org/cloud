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
  invalid_tool_call_arguments: z.array(toolCallArgumentErrorSchema),
});

export type ApiRequestLogError = z.infer<typeof apiRequestLogErrorSchema>;

type ToolCallError = z.infer<typeof toolCallArgumentErrorSchema>;

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
    const chunk: OpenAI.Chat.Completions.ChatCompletionChunk = JSON.parse(line);
    const choice = chunk.choices.find(c => c.index === 0);
    for (const toolCall of choice?.delta.tool_calls ?? []) {
      const acc = byIndex.get(toolCall.index) ?? { id: '', name: '', arguments: '' };
      if (toolCall.id) acc.id = toolCall.id;
      if (toolCall.function?.name) acc.name = toolCall.function.name;
      acc.arguments += toolCall.function?.arguments ?? '';
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
    const event = JSON.parse(line);
    if (event.type !== 'response.output_item.done' || event.item?.type !== 'function_call')
      continue;
    const callId: string = event.item.call_id;
    const name: string = event.item.name;
    const argsStr: string = event.item.arguments;
    if (!checkKnownTool(knownToolNames, callId, name, errors)) continue;
    const result = parseArgsString(argsStr, callId, name, errors);
    if (result.ok) {
      validateAgainstSchema(result.parsed, toolSchemaByName.get(name), callId, name, errors);
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
    const event = JSON.parse(line);
    if (event.type === 'content_block_start' && event.content_block?.type === 'tool_use') {
      const id: string = event.content_block.id;
      const name: string = event.content_block.name;
      byIndex.set(event.index, { id, name, arguments: '' });
    } else if (event.type === 'content_block_delta' && event.delta?.type === 'input_json_delta') {
      const acc = byIndex.get(event.index);
      if (acc) acc.arguments += event.delta.partial_json;
    }
  }

  const errors: ToolCallError[] = [];
  for (const [, acc] of byIndex) {
    if (!checkKnownTool(knownToolNames, acc.id, acc.name, errors)) continue;
    const result = parseArgsString(acc.arguments, acc.id, acc.name, errors);
    if (result.ok) {
      // acc.arguments is accumulated JSON — validate against tool schema
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

/**
 * Checks SSE-streamed response tool call arguments for JSON parse errors or schema mismatches.
 * Returns null if the response is not an SSE stream or if no errors are found.
 */
export function detectToolCallArgumentErrors(
  responseText: string,
  request: GatewayRequest
): ApiRequestLogError | null {
  const lines = parseSseDataLines(responseText);
  if (lines.length === 0) return null;

  let errors: ToolCallError[];
  try {
    if (request.kind === 'chat_completions') {
      errors = detectChatCompletionSseErrors(lines, request.body.tools);
    } else if (request.kind === 'responses') {
      errors = detectResponsesSseErrors(lines, request.body.tools);
    } else {
      errors = detectMessagesSseErrors(lines, request.body.tools);
    }
  } catch {
    return null;
  }

  if (errors.length === 0) return null;
  return { invalid_tool_call_arguments: errors };
}
