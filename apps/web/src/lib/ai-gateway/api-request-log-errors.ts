import * as z from 'zod';
import type OpenAI from 'openai';
import type Anthropic from '@anthropic-ai/sdk';
import type { GatewayRequest } from '@/lib/ai-gateway/providers/openrouter/types';

export const toolCallArgumentErrorSchema = z.object({
  tool_call_id: z.string(),
  tool_name: z.string(),
  kind: z.enum(['unparseable_json', 'schema_mismatch']),
  details: z.string().optional(),
});

export const apiRequestLogErrorSchema = z.object({
  invalid_tool_call_arguments: z.array(toolCallArgumentErrorSchema),
});

export type ApiRequestLogError = z.infer<typeof apiRequestLogErrorSchema>;

type ToolCallError = z.infer<typeof toolCallArgumentErrorSchema>;

function validateAgainstSchema(
  parsedArgs: unknown,
  parameters: unknown,
  toolCallId: string,
  toolName: string,
  errors: ToolCallError[],
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
      details: result.error.message,
    });
  }
}

function parseArgsString(
  argsStr: string,
  toolCallId: string,
  toolName: string,
  errors: ToolCallError[],
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

function detectChatCompletionErrors(
  response: OpenAI.Chat.ChatCompletion,
  tools: OpenAI.Chat.ChatCompletionTool[] | null | undefined,
): ToolCallError[] {
  const toolSchemaByName = new Map<string, unknown>();
  for (const tool of tools ?? []) {
    if (tool.type === 'function') {
      toolSchemaByName.set(tool.function.name, tool.function.parameters);
    }
  }

  const errors: ToolCallError[] = [];
  for (const choice of response.choices ?? []) {
    for (const toolCall of choice.message.tool_calls ?? []) {
      if (toolCall.type !== 'function') continue;
      const { name, arguments: argsStr } = toolCall.function;
      const result = parseArgsString(argsStr, toolCall.id, name, errors);
      if (result.ok) {
        validateAgainstSchema(result.parsed, toolSchemaByName.get(name), toolCall.id, name, errors);
      }
    }
  }
  return errors;
}

function detectResponsesErrors(
  response: OpenAI.Responses.Response,
  tools: OpenAI.Responses.ResponseCreateParams['tools'],
): ToolCallError[] {
  const toolSchemaByName = new Map<string, unknown>();
  for (const tool of tools ?? []) {
    if (tool.type === 'function') {
      toolSchemaByName.set(tool.name, tool.parameters);
    }
  }

  const errors: ToolCallError[] = [];
  for (const item of response.output ?? []) {
    if (item.type !== 'function_call') continue;
    const { call_id, name, arguments: argsStr } = item;
    const result = parseArgsString(argsStr, call_id, name, errors);
    if (result.ok) {
      validateAgainstSchema(result.parsed, toolSchemaByName.get(name), call_id, name, errors);
    }
  }
  return errors;
}

function detectMessagesErrors(
  response: Anthropic.Messages.Message,
  tools: Anthropic.MessageCreateParams['tools'],
): ToolCallError[] {
  const toolSchemaByName = new Map<string, unknown>();
  for (const tool of tools ?? []) {
    // Anthropic.Tool has input_schema; server tools (BashTool, TextEditorTool, etc.) do not
    if ('input_schema' in tool) {
      toolSchemaByName.set(tool.name, tool.input_schema);
    }
  }

  const errors: ToolCallError[] = [];
  for (const block of response.content ?? []) {
    if (block.type !== 'tool_use') continue;
    // block.input is already a parsed object, not a JSON string
    validateAgainstSchema(block.input, toolSchemaByName.get(block.name), block.id, block.name, errors);
  }
  return errors;
}

/**
 * Checks response tool call arguments for JSON parse errors or schema mismatches.
 * Returns null if there are no errors or the response body is not parseable JSON.
 */
export function detectToolCallArgumentErrors(
  responseText: string,
  request: GatewayRequest,
): ApiRequestLogError | null {
  try {
    // JSON.parse returns `any`; the detector functions handle unexpected shapes defensively
    const parsed = JSON.parse(responseText);
    let errors: ToolCallError[];
    if (request.kind === 'chat_completions') {
      errors = detectChatCompletionErrors(parsed, request.body.tools);
    } else if (request.kind === 'responses') {
      errors = detectResponsesErrors(parsed, request.body.tools);
    } else {
      errors = detectMessagesErrors(parsed, request.body.tools);
    }
    if (errors.length === 0) return null;
    return { invalid_tool_call_arguments: errors };
  } catch {
    return null;
  }
}
