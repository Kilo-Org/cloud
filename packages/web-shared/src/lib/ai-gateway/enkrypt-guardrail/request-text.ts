import type { GatewayRequest } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/types';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function partTexts(part: unknown): string[] {
  if (typeof part === 'string') return [part];
  if (Array.isArray(part)) return contentTexts(part);
  if (!isRecord(part)) return [];
  if (part.type === 'tool_use' || part.type === 'server_tool_use' || part.type === 'mcp_tool_use') {
    return callTexts(part);
  }
  if (part.type === 'thinking') return contentTexts(part.thinking);
  if (part.type === 'reasoning.summary') return contentTexts(part.summary);
  if (part.type === 'refusal') return contentTexts(part.refusal);
  let texts = contentTexts(part.text).concat(contentTexts(part.content));
  if (part.type === 'document') {
    texts = contentTexts([part.title, part.context]).concat(texts);
  }
  if (part.type === 'search_result' || part.type === 'web_search_result') {
    texts = contentTexts(part.title).concat(texts);
  }
  if (
    part.type === 'bash_code_execution_result' ||
    part.type === 'code_execution_result' ||
    part.type === 'encrypted_code_execution_result'
  ) {
    texts = texts.concat(contentTexts([part.stdout, part.stderr]));
  }
  if (part.type === 'text_editor_code_execution_str_replace_result') {
    texts = texts.concat(contentTexts(part.lines));
  }
  if (typeof part.type === 'string' && part.type.endsWith('_tool_result_error')) {
    texts = texts.concat(contentTexts(part.error_message));
  }
  if (part.type === 'document' && isRecord(part.source)) {
    if (part.source.type === 'text' && typeof part.source.data === 'string') {
      texts.push(part.source.data);
    }
    if (part.source.type === 'content') texts = texts.concat(contentTexts(part.source.content));
  }
  return texts;
}

function contentTexts(content: unknown): string[] {
  if (typeof content === 'string') return [content];
  if (Array.isArray(content)) return content.flatMap(partTexts);
  return partTexts(content);
}

function jsonInputTexts(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (value === null || typeof value !== 'object') return [];
  return [JSON.stringify(value)];
}

function callTexts(call: unknown): string[] {
  if (!isRecord(call)) return [];
  return [
    ...contentTexts(call.name),
    ...jsonInputTexts(call.arguments),
    ...jsonInputTexts(call.input),
  ];
}

function formatTexts(format: unknown): string[] {
  if (!isRecord(format)) return [];
  const definition = isRecord(format.json_schema) ? format.json_schema : format;
  return [
    ...contentTexts([definition.name, definition.description]),
    ...jsonInputTexts(definition.schema),
    ...(format.type === 'grammar' ? contentTexts(format.definition) : []),
  ];
}

function toolDefinitionTexts(tool: unknown): string[] {
  if (!isRecord(tool)) return [];
  const definition = isRecord(tool.function)
    ? tool.function
    : isRecord(tool.custom)
      ? tool.custom
      : tool;
  return [
    ...contentTexts([definition.name, definition.description, definition.server_description]),
    ...jsonInputTexts(definition.parameters),
    ...jsonInputTexts(definition.input_schema),
    ...jsonInputTexts(definition.output_schema),
    ...jsonInputTexts(definition.input_examples),
    ...formatTexts(definition.format),
    ...(Array.isArray(definition.tools) ? definition.tools.flatMap(toolDefinitionTexts) : []),
  ];
}

type RequestText = { source: 'input' | 'tool'; text: string };

function inputTexts(content: unknown): RequestText[] {
  return contentTexts(content).map(text => ({ source: 'input', text }));
}

function toolTexts(content: unknown): RequestText[] {
  return contentTexts(content).map(text => ({ source: 'tool', text }));
}

function chatCompletionsTexts(message: unknown): RequestText[] {
  if (!isRecord(message)) return [];
  if (message.role === 'tool' || message.role === 'function') {
    return toolTexts(message.content);
  }
  return [
    ...inputTexts([
      message.content,
      message.refusal,
      message.reasoning,
      message.reasoning_content,
      message.reasoning_details,
    ]),
    ...inputTexts(callTexts(message.function_call)),
    ...(Array.isArray(message.tool_calls)
      ? message.tool_calls.flatMap(call =>
          isRecord(call) ? inputTexts([...callTexts(call.function), ...callTexts(call.custom)]) : []
        )
      : []),
  ];
}

const ANTHROPIC_TOOL_BLOCK_TYPES = new Set(['tool_result', 'search_result']);

function messagesTexts(message: unknown): RequestText[] {
  if (!isRecord(message)) return [];
  const content = message.content;
  if (!Array.isArray(content)) return inputTexts(content);
  const blocks: unknown[] = content;
  return blocks.flatMap(block =>
    isRecord(block) &&
    typeof block.type === 'string' &&
    (ANTHROPIC_TOOL_BLOCK_TYPES.has(block.type) || block.type.endsWith('_tool_result'))
      ? toolTexts(block)
      : inputTexts(block)
  );
}

function responsesTexts(item: unknown): RequestText[] {
  if (!isRecord(item)) return [];
  const type = typeof item.type === 'string' ? item.type : undefined;
  if (type === 'shell_call_output') {
    return Array.isArray(item.output)
      ? item.output.flatMap(output =>
          isRecord(output) ? toolTexts([output.stdout, output.stderr]) : []
        )
      : [];
  }
  if (type?.endsWith('_call_output')) return toolTexts(item.output);
  if (type === 'program_output') return toolTexts(item.result);
  if (type === 'mcp_list_tools' || type === 'tool_search_output') {
    return toolTexts([
      ...(Array.isArray(item.tools) ? item.tools.flatMap(toolDefinitionTexts) : []),
      item.error,
    ]);
  }
  if (type === 'additional_tools') {
    return inputTexts(Array.isArray(item.tools) ? item.tools.flatMap(toolDefinitionTexts) : []);
  }
  let texts = inputTexts(item.content);
  if (type === 'reasoning') texts = texts.concat(inputTexts(item.summary));
  if (type === 'function_call' || type === 'custom_tool_call' || type === 'mcp_approval_request') {
    texts = texts.concat(inputTexts(callTexts(item)));
  }
  if (type === 'mcp_call') {
    texts = texts.concat(inputTexts(callTexts(item)), toolTexts([item.output, item.error]));
  }
  if (type === 'file_search_call') {
    texts = texts.concat(inputTexts(item.queries), toolTexts(item.results));
  }
  if (type === 'code_interpreter_call') {
    texts = texts.concat(inputTexts(item.code));
    if (Array.isArray(item.outputs)) {
      texts = texts.concat(
        item.outputs.flatMap(output =>
          isRecord(output) && output.type === 'logs' ? toolTexts(output.logs) : []
        )
      );
    }
  }
  if (type === 'program') texts = texts.concat(inputTexts(item.code));
  if (type === 'mcp_approval_response') texts = texts.concat(inputTexts(item.reason));
  if (isRecord(item.action)) {
    texts = texts.concat(
      inputTexts([item.action.command, item.action.commands, item.action.text, item.action.query])
    );
  }
  if (type === 'apply_patch_call' && isRecord(item.operation)) {
    texts = texts.concat(inputTexts([item.operation.path, item.operation.diff]));
  }
  return texts;
}

function requestTexts(request: GatewayRequest): RequestText[] {
  const body: unknown = request.body;
  if (!isRecord(body)) return [];
  const definitions = inputTexts([
    ...(Array.isArray(body.tools) ? body.tools.flatMap(toolDefinitionTexts) : []),
    ...(Array.isArray(body.functions) ? body.functions.flatMap(toolDefinitionTexts) : []),
    ...formatTexts(body.response_format),
    ...formatTexts(body.output_format),
    ...(isRecord(body.text) ? formatTexts(body.text.format) : []),
    ...(isRecord(body.output_config) ? formatTexts(body.output_config.format) : []),
  ]);
  if (request.kind === 'responses') {
    return [
      ...inputTexts(body.instructions),
      ...(Array.isArray(body.input) ? body.input.flatMap(responsesTexts) : inputTexts(body.input)),
      ...definitions,
    ];
  }
  return [
    ...(request.kind === 'messages' ? inputTexts(body.system) : []),
    ...(Array.isArray(body.messages)
      ? body.messages.flatMap(request.kind === 'messages' ? messagesTexts : chatCompletionsTexts)
      : []),
    ...definitions,
  ];
}

/**
 * Every request can rewrite history, including assistant and system messages. Scan the full
 * conversation rather than trusting earlier turns, respecting the organization's tool-result scope.
 */
export function extractRequestText(
  request: GatewayRequest,
  { includeToolResults }: { includeToolResults: boolean }
): string {
  return requestTexts(request)
    .filter(({ source }) => includeToolResults || source === 'input')
    .map(({ text }) => text.trim())
    .filter(text => text.length > 0)
    .join('\n\n');
}
