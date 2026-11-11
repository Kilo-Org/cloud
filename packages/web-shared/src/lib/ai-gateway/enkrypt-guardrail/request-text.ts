import type Anthropic from '@anthropic-ai/sdk';
import type OpenAI from 'openai';
import type { ReasoningDetailUnion } from '@kilocode/web-shared/lib/ai-gateway/custom-llm/reasoning-details';
import type {
  GatewayMessagesRequest,
  GatewayRequest,
  GatewayResponsesRequest,
  MessageWithReasoning,
  OpenRouterChatCompletionRequest,
} from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/types';

type Text = string | null | undefined;

type RequestSegment = Text[];

/** Tool inputs and schemas are scanned as the JSON the model reads. */
function jsonText(value: unknown): Text {
  if (typeof value === 'string') return value;
  if (value === null || typeof value !== 'object') return undefined;
  return JSON.stringify(value);
}

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/**
 * Clients can send part, item, and tool types newer than the SDK types. Rather than dropping them,
 * scan the fields that carry model-visible text across the APIs.
 */
function unrecognizedTexts(value: never): Text[] {
  return jsonTexts(value);
}

function jsonTexts(value: JsonValue | undefined): Text[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(jsonTexts);
  if (typeof value !== 'object' || value === null) return [];
  return [
    ...jsonTexts(value.name),
    ...jsonTexts(value.description),
    ...jsonTexts(value.text),
    ...jsonTexts(value.content),
  ];
}

type ChatContentPart =
  | OpenAI.Chat.ChatCompletionContentPart
  | OpenAI.Chat.ChatCompletionContentPartRefusal;

function chatPartTexts(part: ChatContentPart): Text[] {
  switch (part.type) {
    case 'text':
      return [part.text];
    case 'refusal':
      return [part.refusal];
    case 'image_url':
    case 'input_audio':
    case 'file':
      return [];
    default:
      return unrecognizedTexts(part);
  }
}

function chatContentTexts(content: string | ChatContentPart[] | null | undefined): Text[] {
  if (typeof content === 'string') return [content];
  return content ? content.flatMap(chatPartTexts) : [];
}

function reasoningDetailTexts(detail: ReasoningDetailUnion): Text[] {
  switch (detail.type) {
    case 'reasoning.text':
      return [detail.text];
    case 'reasoning.summary':
      return [detail.summary];
    case 'reasoning.encrypted':
      return [];
    default:
      return unrecognizedTexts(detail);
  }
}

function chatToolCallTexts(call: OpenAI.Chat.ChatCompletionMessageToolCall): Text[] {
  switch (call.type) {
    case 'function':
      return [call.function.name, call.function.arguments];
    case 'custom':
      return [call.custom.name, call.custom.input];
    default:
      return unrecognizedTexts(call);
  }
}

function chatMessageTexts(
  message: OpenAI.Chat.ChatCompletionMessageParam & MessageWithReasoning
): Text[] {
  switch (message.role) {
    case 'tool':
      return chatContentTexts(message.content);
    case 'function':
      return [message.content];
    case 'system':
    case 'developer':
    case 'user':
      return chatContentTexts(message.content);
    case 'assistant':
      return [
        ...chatContentTexts(message.content),
        message.refusal,
        message.reasoning,
        message.reasoning_content,
        ...(message.reasoning_details ?? []).flatMap(reasoningDetailTexts),
        message.function_call?.name,
        message.function_call?.arguments,
        ...(message.tool_calls ?? []).flatMap(chatToolCallTexts),
      ];
    default:
      return unrecognizedTexts(message);
  }
}

function chatToolDefinitionTexts(tool: OpenAI.Chat.ChatCompletionTool): Text[] {
  switch (tool.type) {
    case 'function':
      return [tool.function.name, tool.function.description, jsonText(tool.function.parameters)];
    case 'custom': {
      const { format } = tool.custom;
      return [
        tool.custom.name,
        tool.custom.description,
        format?.type === 'grammar' ? format.grammar.definition : undefined,
      ];
    }
    default:
      return unrecognizedTexts(tool);
  }
}

function chatResponseFormatTexts(
  format: OpenRouterChatCompletionRequest['response_format']
): Text[] {
  if (format?.type !== 'json_schema') return [];
  const { name, description, schema } = format.json_schema;
  return [name, description, jsonText(schema)];
}

function chatCompletionsSegments(body: OpenRouterChatCompletionRequest): RequestSegment[] {
  return [
    ...(body.tools ?? []).map(chatToolDefinitionTexts),
    ...(body.functions ?? []).map(fn => [fn.name, fn.description, jsonText(fn.parameters)]),
    chatResponseFormatTexts(body.response_format),
    ...body.messages.map(chatMessageTexts),
  ];
}

type AnthropicBlock = Anthropic.Beta.BetaContentBlockParam;

function anthropicTextBlocksTexts(blocks: Anthropic.Beta.BetaTextBlockParam[]): Text[] {
  return blocks.map(block => block.text);
}

function anthropicDocumentTexts(document: Anthropic.Beta.BetaRequestDocumentBlock): Text[] {
  const { source } = document;
  const texts: Text[] = [document.title, document.context];
  if (source.type === 'text') return texts.concat(source.data);
  if (source.type !== 'content') return texts;
  return typeof source.content === 'string'
    ? texts.concat(source.content)
    : texts.concat(source.content.map(part => (part.type === 'text' ? part.text : undefined)));
}

function anthropicSearchResultTexts(result: Anthropic.Beta.BetaSearchResultBlockParam): Text[] {
  return [result.title, ...anthropicTextBlocksTexts(result.content)];
}

type AnthropicToolResultContent = NonNullable<Anthropic.Beta.BetaToolResultBlockParam['content']>;

function anthropicToolResultTexts(content: AnthropicToolResultContent | undefined): Text[] {
  if (typeof content === 'string') return [content];
  return (content ?? []).flatMap(part => {
    switch (part.type) {
      case 'text':
        return [part.text];
      case 'document':
        return anthropicDocumentTexts(part);
      case 'search_result':
        return anthropicSearchResultTexts(part);
      case 'image':
      case 'tool_reference':
        return [];
      default:
        return unrecognizedTexts(part);
    }
  });
}

function anthropicCodeExecutionTexts(
  result:
    | Anthropic.Beta.BetaCodeExecutionToolResultBlockParam['content']
    | Anthropic.Beta.BetaBashCodeExecutionToolResultBlockParam['content']
): Text[] {
  switch (result.type) {
    case 'code_execution_result':
    case 'bash_code_execution_result':
      return [result.stdout, result.stderr];
    case 'encrypted_code_execution_result':
      return [result.stderr];
    case 'code_execution_tool_result_error':
    case 'bash_code_execution_tool_result_error':
      return [];
    default:
      return unrecognizedTexts(result);
  }
}

function anthropicTextEditorTexts(
  result: Anthropic.Beta.BetaTextEditorCodeExecutionToolResultBlockParam['content']
): Text[] {
  switch (result.type) {
    case 'text_editor_code_execution_view_result':
      return [result.content];
    case 'text_editor_code_execution_str_replace_result':
      return result.lines ?? [];
    case 'text_editor_code_execution_tool_result_error':
      return [result.error_message];
    case 'text_editor_code_execution_create_result':
      return [];
    default:
      return unrecognizedTexts(result);
  }
}

function anthropicBlockTexts(block: AnthropicBlock): Text[] {
  switch (block.type) {
    case 'text':
      return [block.text];
    case 'thinking':
      return [block.thinking];
    case 'tool_use':
    case 'server_tool_use':
    case 'mcp_tool_use':
      return [block.name, jsonText(block.input)];
    case 'document':
      return anthropicDocumentTexts(block);
    case 'compaction':
      return [block.content];
    case 'mid_conv_system':
      return anthropicTextBlocksTexts(block.content);
    case 'tool_result':
    case 'mcp_tool_result':
      return anthropicToolResultTexts(block.content);
    case 'search_result':
      return anthropicSearchResultTexts(block);
    case 'web_search_tool_result':
      return Array.isArray(block.content) ? block.content.map(result => result.title) : [];
    case 'web_fetch_tool_result':
      return block.content.type === 'web_fetch_result'
        ? anthropicDocumentTexts(block.content.content)
        : [];
    case 'code_execution_tool_result':
    case 'bash_code_execution_tool_result':
      return anthropicCodeExecutionTexts(block.content);
    case 'text_editor_code_execution_tool_result':
      return anthropicTextEditorTexts(block.content);
    case 'tool_search_tool_result':
      return block.content.type === 'tool_search_tool_result_error'
        ? [block.content.error_message]
        : [];
    case 'advisor_tool_result':
      return block.content.type === 'advisor_result' ? [block.content.text] : [];
    case 'image':
    case 'redacted_thinking':
    case 'container_upload':
    case 'fallback':
      return [];
    default:
      return unrecognizedTexts(block);
  }
}

function anthropicMessageTexts(message: Anthropic.Beta.BetaMessageParam): Text[] {
  return typeof message.content === 'string'
    ? [message.content]
    : message.content.flatMap(anthropicBlockTexts);
}

function anthropicToolDefinitionTexts(tool: Anthropic.Beta.BetaToolUnion): Text[] {
  return [
    'name' in tool ? tool.name : undefined,
    'description' in tool ? tool.description : undefined,
    'input_schema' in tool ? jsonText(tool.input_schema) : undefined,
    'input_examples' in tool ? jsonText(tool.input_examples) : undefined,
  ];
}

type AnthropicTextSources = Pick<
  Anthropic.Beta.MessageCreateParams,
  'system' | 'messages' | 'tools' | 'output_config' | 'output_format'
>;

function messagesSegments(request: GatewayMessagesRequest): RequestSegment[] {
  const body: AnthropicTextSources = request;
  const { system } = body;
  return [
    ...(body.tools ?? []).map(anthropicToolDefinitionTexts),
    [jsonText(body.output_format?.schema), jsonText(body.output_config?.format?.schema)],
    typeof system === 'string' ? [system] : anthropicTextBlocksTexts(system ?? []),
    ...body.messages.map(anthropicMessageTexts),
  ];
}

type ResponsesTool = OpenAI.Responses.Tool | OpenAI.Responses.NamespaceTool.Function;

function responsesFormatTexts(
  format: OpenAI.Responses.ResponseFormatTextConfig | OpenAI.CustomToolInputFormat | undefined
): Text[] {
  switch (format?.type) {
    case 'json_schema':
      return [format.name, format.description, jsonText(format.schema)];
    case 'grammar':
      return [format.definition];
    default:
      return [];
  }
}

function responsesToolDefinitionTexts(tool: ResponsesTool): Text[] {
  switch (tool.type) {
    case 'function':
      return [tool.name, tool.description, jsonText(tool.parameters), jsonText(tool.output_schema)];
    case 'custom':
      return [tool.name, tool.description, ...responsesFormatTexts(tool.format)];
    case 'namespace':
      return [tool.name, tool.description, ...tool.tools.flatMap(responsesToolDefinitionTexts)];
    case 'tool_search':
      return [tool.description, jsonText(tool.parameters)];
    case 'mcp':
      return [tool.server_description];
    case 'file_search':
    case 'computer':
    case 'computer_use_preview':
    case 'web_search':
    case 'web_search_2025_08_26':
    case 'web_search_preview':
    case 'web_search_preview_2025_03_11':
    case 'code_interpreter':
    case 'programmatic_tool_calling':
    case 'image_generation':
    case 'local_shell':
    case 'shell':
    case 'apply_patch':
      return [];
    default:
      return unrecognizedTexts(tool);
  }
}

type ResponsesMessagePart =
  | OpenAI.Responses.ResponseInputContent
  | OpenAI.Responses.ResponseFunctionCallOutputItem
  | OpenAI.Responses.ResponseOutputText
  | OpenAI.Responses.ResponseOutputRefusal;

function responsesPartTexts(part: ResponsesMessagePart): Text[] {
  switch (part.type) {
    case 'input_text':
    case 'output_text':
      return [part.text];
    case 'refusal':
      return [part.refusal];
    case 'input_image':
    case 'input_file':
      return [];
    default:
      return unrecognizedTexts(part);
  }
}

function responsesContentTexts(content: string | ResponsesMessagePart[]): Text[] {
  return typeof content === 'string' ? [content] : content.flatMap(responsesPartTexts);
}

type ComputerAction = NonNullable<OpenAI.Responses.ResponseComputerToolCall['action']>;

function computerActionTexts(action: ComputerAction): Text[] {
  return action.type === 'type' ? [action.text] : [];
}

function responsesItemTexts(item: OpenAI.Responses.ResponseInputItem): Text[] {
  switch (item.type) {
    case undefined:
    case null:
    case 'message':
      return 'content' in item ? responsesContentTexts(item.content) : [];
    case 'reasoning':
      return [
        ...(item.content ?? []).map(content => content.text),
        ...item.summary.map(summary => summary.text),
      ];
    case 'function_call':
      return [item.name, item.arguments];
    case 'custom_tool_call':
      return [item.name, item.input];
    case 'mcp_approval_request':
      return [item.name, item.arguments];
    case 'mcp_approval_response':
      return [item.reason];
    case 'mcp_call':
      return [item.name, item.arguments, item.output, item.error];
    case 'tool_search_call':
      return [jsonText(item.arguments)];
    case 'file_search_call':
      return [...item.queries, ...(item.results ?? []).map(result => result.text)];
    case 'web_search_call':
      return item.action.type === 'search'
        ? [item.action.query, ...(item.action.queries ?? [])]
        : [];
    case 'computer_call':
      return [
        ...(item.action ? computerActionTexts(item.action) : []),
        ...(item.actions ?? []).flatMap(computerActionTexts),
      ];
    case 'code_interpreter_call':
      return [
        item.code,
        ...(item.outputs ?? []).map(output => (output.type === 'logs' ? output.logs : undefined)),
      ];
    case 'local_shell_call':
      return item.action.command;
    case 'shell_call':
      return item.action.commands;
    case 'apply_patch_call':
      return 'diff' in item.operation
        ? [item.operation.path, item.operation.diff]
        : [item.operation.path];
    case 'program':
      return [item.code];
    case 'additional_tools':
      return item.tools.flatMap(responsesToolDefinitionTexts);
    case 'function_call_output':
    case 'custom_tool_call_output':
      return responsesContentTexts(item.output);
    case 'local_shell_call_output':
    case 'apply_patch_call_output':
      return [item.output];
    case 'shell_call_output':
      return item.output.flatMap(output => [output.stdout, output.stderr]);
    case 'program_output':
      return [item.result];
    case 'mcp_list_tools':
      return [
        ...item.tools.flatMap(tool => [tool.name, tool.description, jsonText(tool.input_schema)]),
        item.error,
      ];
    case 'tool_search_output':
      return item.tools.flatMap(responsesToolDefinitionTexts);
    case 'computer_call_output':
    case 'image_generation_call':
    case 'compaction':
    case 'compaction_trigger':
    case 'item_reference':
      return [];
    default:
      return unrecognizedTexts(item);
  }
}

function responsesSegments(body: GatewayResponsesRequest): RequestSegment[] {
  const { input } = body;
  return [
    ...(body.tools ?? []).map(responsesToolDefinitionTexts),
    responsesFormatTexts(body.text?.format),
    [body.instructions],
    ...(typeof input === 'string' ? [[input]] : (input ?? []).map(responsesItemTexts)),
  ];
}

/**
 * Tool and output-format definitions come first: they rarely change within a session, so the
 * conversation that grows behind them stays a prefix of the next request.
 */
function requestSegments(request: GatewayRequest): RequestSegment[] {
  switch (request.kind) {
    case 'chat_completions':
      return chatCompletionsSegments(request.body);
    case 'messages':
      return messagesSegments(request.body);
    case 'responses':
      return responsesSegments(request.body);
  }
}

const SEGMENT_SEPARATOR = '\n\n';

export function joinRequestSegments(segments: string[]): string {
  return segments.join(SEGMENT_SEPARATOR);
}

/**
 * Every request can rewrite history, including assistant and system messages. Scan the full
 * conversation, including all textual tool results, rather than trusting earlier turns.
 * Binary media, encrypted content, and transport settings are never scanned.
 *
 * Returns one entry per tool definition, output format, system prompt, and message or input item
 * that has scannable text, in order. Joined with `joinRequestSegments`, they are the scanned text.
 */
export function extractRequestSegments(request: GatewayRequest): string[] {
  return requestSegments(request).flatMap(segment => {
    const joined = joinRequestSegments(
      segment.flatMap(text => {
        const trimmed = text?.trim();
        return trimmed ? [trimmed] : [];
      })
    );
    return joined ? [joined] : [];
  });
}
