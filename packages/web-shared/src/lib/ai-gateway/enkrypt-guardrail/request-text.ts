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

/**
 * Text of one kind from one source, such as a user message, assistant reasoning, or the result of
 * a named tool. `source` is built only from fixed labels and validated tool names, never from
 * free-form request text, so request content cannot choose its own label.
 */
type Part = { source: string; texts: Text[] };

type RequestSegment = Part[];

type ToolNames = Map<string, string>;

type ToolCallName = [id: string, name: string];

/**
 * Each message's segment, with tool results labelled by the name of the call they answer. Names
 * come only from that message and earlier ones, and the first call with an ID names it, so later
 * messages never relabel an earlier segment and earlier segments stay cached prefixes.
 */
function segmentsNamingToolResults<Message>(
  messages: Message[],
  callNames: (message: Message) => ToolCallName[],
  parts: (message: Message, toolNames: ToolNames) => Part[]
): RequestSegment[] {
  const toolNames: ToolNames = new Map();
  return messages.map(message => {
    for (const [id, name] of callNames(message)) {
      if (!toolNames.has(id)) toolNames.set(id, name);
    }
    return parts(message, toolNames);
  });
}

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

const LABELLED_TOOL_NAME = /^[\w.:-]{1,64}$/;

function labelledToolName(name: Text): string | null {
  const trimmed = name?.trim();
  return trimmed && LABELLED_TOOL_NAME.test(trimmed) ? trimmed : null;
}

/** A tool name that cannot be a label stays in the scanned text instead. */
function toolCall(name: Text, texts: Text[]): Part {
  const labelled = labelledToolName(name);
  return labelled
    ? { source: `assistant tool call ${labelled}`, texts }
    : { source: 'assistant tool call', texts: [name, ...texts] };
}

function toolResultSource(name: Text): string {
  const labelled = labelledToolName(name);
  return labelled ? `tool result ${labelled}` : 'tool result';
}

function toolResult(name: Text, texts: Text[]): Part {
  return { source: toolResultSource(name), texts };
}

type Speaker = 'system' | 'developer' | 'user' | 'assistant' | 'unknown role';

function speaker(role: unknown): Speaker {
  switch (role) {
    case 'system':
    case 'developer':
    case 'user':
    case 'assistant':
      return role;
    default:
      return 'unknown role';
  }
}

function messageSource(role: Speaker): string {
  return role === 'system' || role === 'developer' ? `${role} instructions` : `${role} message`;
}

/** Content the API types do not describe is not labelled as the speaker's own message. */
function unrecognizedSource(role: Speaker): string {
  return `${role} content`;
}

type ChatContentPart =
  | OpenAI.Chat.ChatCompletionContentPart
  | OpenAI.Chat.ChatCompletionContentPartRefusal;

function chatContentParts(
  source: string,
  unrecognized: string,
  content: string | ChatContentPart[] | null | undefined
): Part[] {
  if (typeof content === 'string') return [{ source, texts: [content] }];
  return (content ?? []).flatMap((part): Part[] => {
    switch (part.type) {
      case 'text':
        return [{ source, texts: [part.text] }];
      case 'refusal':
        return [{ source, texts: [part.refusal] }];
      case 'image_url':
      case 'input_audio':
      case 'file':
        return [];
      default:
        return [{ source: unrecognized, texts: unrecognizedTexts(part) }];
    }
  });
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

function chatToolCallPart(call: OpenAI.Chat.ChatCompletionMessageToolCall): Part {
  switch (call.type) {
    case 'function':
      return toolCall(call.function.name, [call.function.arguments]);
    case 'custom':
      return toolCall(call.custom.name, [call.custom.input]);
    default:
      return { source: 'assistant tool call', texts: unrecognizedTexts(call) };
  }
}

type ChatMessage = OpenAI.Chat.ChatCompletionMessageParam & MessageWithReasoning;

function chatMessageParts(message: ChatMessage, toolNames: ToolNames): Part[] {
  switch (message.role) {
    case 'tool': {
      const source = toolResultSource(toolNames.get(message.tool_call_id));
      return chatContentParts(source, source, message.content);
    }
    case 'function':
      return [toolResult(message.name, [message.content])];
    case 'system':
    case 'developer':
    case 'user': {
      const role = speaker(message.role);
      return chatContentParts(messageSource(role), unrecognizedSource(role), message.content);
    }
    case 'assistant':
      return [
        ...chatContentParts('assistant message', 'assistant content', message.content),
        { source: 'assistant message', texts: [message.refusal] },
        {
          source: 'assistant reasoning',
          texts: [
            message.reasoning,
            message.reasoning_content,
            ...(message.reasoning_details ?? []).flatMap(reasoningDetailTexts),
          ],
        },
        ...(message.function_call
          ? [toolCall(message.function_call.name, [message.function_call.arguments])]
          : []),
        ...(message.tool_calls ?? []).map(chatToolCallPart),
      ];
    default:
      return [{ source: 'unknown role message', texts: unrecognizedTexts(message) }];
  }
}

function chatCallNames(message: ChatMessage): ToolCallName[] {
  if (message.role !== 'assistant') return [];
  return (message.tool_calls ?? []).flatMap((call): ToolCallName[] => {
    if (call.type === 'function') return [[call.id, call.function.name]];
    if (call.type === 'custom') return [[call.id, call.custom.name]];
    return [];
  });
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

function toolDefinition(texts: Text[]): RequestSegment {
  return [{ source: 'tool definition', texts }];
}

function responseFormat(texts: Text[]): RequestSegment {
  return [{ source: 'response format', texts }];
}

function chatCompletionsSegments(body: OpenRouterChatCompletionRequest): RequestSegment[] {
  return [
    ...(body.tools ?? []).map(tool => toolDefinition(chatToolDefinitionTexts(tool))),
    ...(body.functions ?? []).map(fn =>
      toolDefinition([fn.name, fn.description, jsonText(fn.parameters)])
    ),
    responseFormat(chatResponseFormatTexts(body.response_format)),
    ...segmentsNamingToolResults(body.messages, chatCallNames, chatMessageParts),
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

function anthropicBlockParts(role: Speaker, block: AnthropicBlock, toolNames: ToolNames): Part[] {
  const result = (toolUseId: string, texts: Text[]) => [
    toolResult(toolNames.get(toolUseId), texts),
  ];
  switch (block.type) {
    case 'text':
      return [{ source: messageSource(role), texts: [block.text] }];
    case 'thinking':
      return [{ source: `${role} reasoning`, texts: [block.thinking] }];
    case 'tool_use':
    case 'server_tool_use':
    case 'mcp_tool_use':
      return [toolCall(block.name, [jsonText(block.input)])];
    case 'document':
      return [{ source: `${role} document`, texts: anthropicDocumentTexts(block) }];
    case 'compaction':
      return [{ source: 'conversation summary', texts: [block.content] }];
    case 'mid_conv_system':
      return [{ source: 'system instructions', texts: anthropicTextBlocksTexts(block.content) }];
    case 'tool_result':
    case 'mcp_tool_result':
      return result(block.tool_use_id, anthropicToolResultTexts(block.content));
    case 'search_result':
      return [{ source: 'search result', texts: anthropicSearchResultTexts(block) }];
    case 'web_search_tool_result':
      return result(
        block.tool_use_id,
        Array.isArray(block.content) ? block.content.map(item => item.title) : []
      );
    case 'web_fetch_tool_result':
      return result(
        block.tool_use_id,
        block.content.type === 'web_fetch_result'
          ? anthropicDocumentTexts(block.content.content)
          : []
      );
    case 'code_execution_tool_result':
    case 'bash_code_execution_tool_result':
      return result(block.tool_use_id, anthropicCodeExecutionTexts(block.content));
    case 'text_editor_code_execution_tool_result':
      return result(block.tool_use_id, anthropicTextEditorTexts(block.content));
    case 'tool_search_tool_result':
      return result(
        block.tool_use_id,
        block.content.type === 'tool_search_tool_result_error' ? [block.content.error_message] : []
      );
    case 'advisor_tool_result':
      return result(
        block.tool_use_id,
        block.content.type === 'advisor_result' ? [block.content.text] : []
      );
    case 'image':
    case 'redacted_thinking':
    case 'container_upload':
    case 'fallback':
      return [];
    default:
      return [{ source: unrecognizedSource(role), texts: unrecognizedTexts(block) }];
  }
}

function anthropicMessageParts(
  message: Anthropic.Beta.BetaMessageParam,
  toolNames: ToolNames
): Part[] {
  const role =
    message.role === 'user' || message.role === 'assistant' ? message.role : 'unknown role';
  return typeof message.content === 'string'
    ? [{ source: messageSource(role), texts: [message.content] }]
    : message.content.flatMap(block => anthropicBlockParts(role, block, toolNames));
}

function anthropicCallNames(message: Anthropic.Beta.BetaMessageParam): ToolCallName[] {
  if (typeof message.content === 'string') return [];
  return message.content.flatMap((block): ToolCallName[] =>
    block.type === 'tool_use' || block.type === 'server_tool_use' || block.type === 'mcp_tool_use'
      ? [[block.id, block.name]]
      : []
  );
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
    ...(body.tools ?? []).map(tool => toolDefinition(anthropicToolDefinitionTexts(tool))),
    responseFormat([
      jsonText(body.output_format?.schema),
      jsonText(body.output_config?.format?.schema),
    ]),
    [
      {
        source: 'system instructions',
        texts: typeof system === 'string' ? [system] : anthropicTextBlocksTexts(system ?? []),
      },
    ],
    ...segmentsNamingToolResults(body.messages, anthropicCallNames, anthropicMessageParts),
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

function responsesContentParts(
  source: string,
  unrecognized: string,
  content: string | ResponsesMessagePart[]
): Part[] {
  if (typeof content === 'string') return [{ source, texts: [content] }];
  return content.flatMap((part): Part[] => {
    switch (part.type) {
      case 'input_text':
      case 'output_text':
        return [{ source, texts: [part.text] }];
      case 'refusal':
        return [{ source, texts: [part.refusal] }];
      case 'input_image':
      case 'input_file':
        return [];
      default:
        return [{ source: unrecognized, texts: unrecognizedTexts(part) }];
    }
  });
}

type ComputerAction = NonNullable<OpenAI.Responses.ResponseComputerToolCall['action']>;

function computerActionTexts(action: ComputerAction): Text[] {
  return action.type === 'type' ? [action.text] : [];
}

function responsesItemParts(
  item: OpenAI.Responses.ResponseInputItem,
  toolNames: ToolNames
): Part[] {
  switch (item.type) {
    case undefined:
    case null:
    case 'message': {
      if (!('content' in item)) return [];
      const role = speaker(item.role);
      return responsesContentParts(messageSource(role), unrecognizedSource(role), item.content);
    }
    case 'reasoning':
      return [
        {
          source: 'assistant reasoning',
          texts: [
            ...(item.content ?? []).map(content => content.text),
            ...item.summary.map(summary => summary.text),
          ],
        },
      ];
    case 'function_call':
      return [toolCall(item.name, [item.arguments])];
    case 'custom_tool_call':
      return [toolCall(item.name, [item.input])];
    case 'mcp_approval_request':
      return [toolCall(item.name, [item.arguments])];
    case 'mcp_approval_response':
      return [{ source: 'tool approval', texts: [item.reason] }];
    case 'mcp_call':
      return [
        toolCall(item.name, [item.arguments]),
        toolResult(item.name, [item.output, item.error]),
      ];
    case 'tool_search_call':
      return [toolCall('tool_search', [jsonText(item.arguments)])];
    case 'file_search_call':
      return [
        toolCall('file_search', item.queries),
        toolResult(
          'file_search',
          (item.results ?? []).map(result => result.text)
        ),
      ];
    case 'web_search_call':
      return [
        toolCall(
          'web_search',
          item.action.type === 'search' ? [item.action.query, ...(item.action.queries ?? [])] : []
        ),
      ];
    case 'computer_call':
      return [
        toolCall('computer', [
          ...(item.action ? computerActionTexts(item.action) : []),
          ...(item.actions ?? []).flatMap(computerActionTexts),
        ]),
      ];
    case 'code_interpreter_call':
      return [
        toolCall('code_interpreter', [item.code]),
        toolResult(
          'code_interpreter',
          (item.outputs ?? []).map(output => (output.type === 'logs' ? output.logs : undefined))
        ),
      ];
    case 'local_shell_call':
      return [toolCall('local_shell', item.action.command)];
    case 'shell_call':
      return [toolCall('shell', item.action.commands)];
    case 'apply_patch_call':
      return [
        toolCall(
          'apply_patch',
          'diff' in item.operation
            ? [item.operation.path, item.operation.diff]
            : [item.operation.path]
        ),
      ];
    case 'program':
      return [toolCall('program', [item.code])];
    case 'additional_tools':
      return [
        { source: 'tool definition', texts: item.tools.flatMap(responsesToolDefinitionTexts) },
      ];
    case 'function_call_output':
    case 'custom_tool_call_output': {
      const source = toolResultSource(toolNames.get(item.call_id));
      return responsesContentParts(source, source, item.output);
    }
    case 'local_shell_call_output':
      return [toolResult('local_shell', [item.output])];
    case 'apply_patch_call_output':
      return [toolResult('apply_patch', [item.output])];
    case 'shell_call_output':
      return [
        toolResult(
          'shell',
          item.output.flatMap(output => [output.stdout, output.stderr])
        ),
      ];
    case 'program_output':
      return [toolResult('program', [item.result])];
    case 'mcp_list_tools':
      return [
        {
          source: 'tool definition',
          texts: [
            ...item.tools.flatMap(tool => [
              tool.name,
              tool.description,
              jsonText(tool.input_schema),
            ]),
            item.error,
          ],
        },
      ];
    case 'tool_search_output':
      return [
        { source: 'tool definition', texts: item.tools.flatMap(responsesToolDefinitionTexts) },
      ];
    case 'computer_call_output':
    case 'image_generation_call':
    case 'compaction':
    case 'compaction_trigger':
    case 'item_reference':
      return [];
    default:
      return [{ source: 'unknown input item', texts: unrecognizedTexts(item) }];
  }
}

function responsesCallNames(item: OpenAI.Responses.ResponseInputItem): ToolCallName[] {
  return item.type === 'function_call' || item.type === 'custom_tool_call'
    ? [[item.call_id, item.name]]
    : [];
}

function responsesSegments(body: GatewayResponsesRequest): RequestSegment[] {
  const { input } = body;
  return [
    ...(body.tools ?? []).map(tool => toolDefinition(responsesToolDefinitionTexts(tool))),
    responseFormat(responsesFormatTexts(body.text?.format)),
    [{ source: 'system instructions', texts: [body.instructions] }],
    ...(typeof input === 'string'
      ? [[{ source: 'user message', texts: [input] }]]
      : segmentsNamingToolResults(input ?? [], responsesCallNames, responsesItemParts)),
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

const SOURCE_MARKER = '[[source:';

const SOURCE_HEADER_PREFIX = `${SOURCE_MARKER} `;

const ESCAPED_SOURCE_MARKER = '[[source\\:';

export function joinRequestSegments(segments: string[]): string {
  return segments.join(SEGMENT_SEPARATOR);
}

export function sourceHeader(source: string): string {
  return `${SOURCE_HEADER_PREFIX}${source}]]`;
}

/**
 * Request text that imitates a source header is escaped, so every `[[source:` in scanned text is a
 * header the gateway wrote. Escaping only adds a backslash; no text is removed.
 */
function escapeSourceMarkers(text: string): string {
  return text.replaceAll(SOURCE_MARKER, ESCAPED_SOURCE_MARKER);
}

function renderSegment(parts: RequestSegment): string {
  const blocks: { source: string; texts: string[] }[] = [];
  for (const { source, texts } of parts) {
    const scannable = texts.flatMap(text => {
      const trimmed = text?.trim();
      return trimmed ? [escapeSourceMarkers(trimmed)] : [];
    });
    if (scannable.length === 0) continue;
    const previous = blocks.at(-1);
    if (previous?.source === source) previous.texts.push(...scannable);
    else blocks.push({ source, texts: scannable });
  }
  return joinRequestSegments(
    blocks.map(({ source, texts }) => `${sourceHeader(source)}\n${joinRequestSegments(texts)}`)
  );
}

/**
 * Every request can rewrite history, including assistant and system messages. Scan the full
 * conversation, including all textual tool results, rather than trusting earlier turns.
 * Binary media, encrypted content, and transport settings are never scanned.
 *
 * Returns one entry per tool definition, output format, system prompt, and message or input item
 * that has scannable text, in order. Joined with `joinRequestSegments`, they are the scanned text.
 * Each run of text from one source starts with a `sourceHeader` line naming its role and type, such
 * as `[[source: tool result bash]]`, so a detector can tell a tool result inside an Anthropic user
 * message, or assistant reasoning, from what the user wrote.
 */
export function extractRequestSegments(request: GatewayRequest): string[] {
  return requestSegments(request).flatMap(segment => {
    const rendered = renderSegment(segment);
    return rendered ? [rendered] : [];
  });
}

/**
 * The texts of the user messages that end at or before `end`, excluding tool results and other
 * user-role content. Every header in `text` was written by the gateway, so each one starts a block.
 */
export function userMessageTextsBefore(text: string, end: number): string[] {
  const header = `${sourceHeader('user message')}\n`;
  const texts: string[] = [];
  let blockStart = text.indexOf(SOURCE_HEADER_PREFIX);
  while (blockStart !== -1) {
    const next = text.indexOf(SOURCE_HEADER_PREFIX, blockStart + 1);
    const blockEnd = next === -1 ? text.length : next - SEGMENT_SEPARATOR.length;
    if (blockEnd > end) break;
    if (text.startsWith(header, blockStart)) {
      texts.push(text.slice(blockStart + header.length, blockEnd));
    }
    blockStart = next;
  }
  return texts;
}

/**
 * Where to start re-sending already-scanned text so that it begins at a source header: the first
 * header in `[earliest, latest]`, or else `earliest`. A start inside a source's text returns that
 * source's header, marked as continued, to send ahead of it.
 */
export function sourceAlignedStart(
  text: string,
  earliest: number,
  latest: number
): { start: number; continuedHeader: string | null } {
  const header = text.indexOf(SOURCE_HEADER_PREFIX, earliest);
  if (header !== -1 && header <= latest) return { start: header, continuedHeader: null };
  const enclosing = text.lastIndexOf(SOURCE_HEADER_PREFIX, earliest);
  if (enclosing === -1) return { start: earliest, continuedHeader: null };
  const headerEnd = text.indexOf(']]\n', enclosing);
  if (headerEnd === -1 || earliest <= headerEnd + 2) {
    return { start: enclosing, continuedHeader: null };
  }
  const source = text.slice(enclosing + SOURCE_HEADER_PREFIX.length, headerEnd);
  return { start: earliest, continuedHeader: sourceHeader(`${source}, continued`) };
}
