import * as z from 'zod';

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

type ChatCompletionResponse = {
  choices?: Array<{
    message?: {
      tool_calls?: Array<{
        id: string;
        type: string;
        function?: {
          name: string;
          arguments: string;
        };
      }>;
    };
  }>;
};

type Tool = {
  type: string;
  function?: {
    name: string;
    parameters?: unknown;
  };
};

/**
 * Checks response tool call arguments for JSON parse errors or schema mismatches.
 * Returns null if there are no errors or the response is not a chat completion with tool calls.
 */
export function detectToolCallArgumentErrors(
  responseText: string,
  tools: Tool[] | undefined
): ApiRequestLogError | null {
  let response: ChatCompletionResponse;
  try {
    response = JSON.parse(responseText) as ChatCompletionResponse;
  } catch {
    return null;
  }

  const toolSchemaByName = new Map<string, unknown>();
  for (const tool of tools ?? []) {
    if (tool.type === 'function' && tool.function) {
      toolSchemaByName.set(tool.function.name, tool.function.parameters);
    }
  }

  const errors: z.infer<typeof toolCallArgumentErrorSchema>[] = [];

  for (const choice of response.choices ?? []) {
    for (const toolCall of choice.message?.tool_calls ?? []) {
      if (toolCall.type !== 'function' || !toolCall.function) continue;

      const { name, arguments: argsStr } = toolCall.function;

      let parsedArgs: unknown;
      try {
        parsedArgs = JSON.parse(argsStr);
      } catch (e) {
        errors.push({
          tool_call_id: toolCall.id,
          tool_name: name,
          kind: 'unparseable_json',
          details: e instanceof Error ? e.message : String(e),
        });
        continue;
      }

      const parameters = toolSchemaByName.get(name);
      if (parameters == null) continue;

      const zodSchema = z.fromJSONSchema(parameters as Parameters<typeof z.fromJSONSchema>[0]);
      const result = zodSchema.safeParse(parsedArgs);
      if (!result.success) {
        errors.push({
          tool_call_id: toolCall.id,
          tool_name: name,
          kind: 'schema_mismatch',
          details: result.error.message,
        });
      }
    }
  }

  if (errors.length === 0) return null;
  return { invalid_tool_call_arguments: errors };
}
