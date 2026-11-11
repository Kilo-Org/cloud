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
 * Model-visible text with a header naming who wrote it and what it is, such as `user`,
 * `tool result`, or `assistant tool call: read_file`. Null `texts` marks content that is never
 * scanned, such as an image, so the scan still shows that it was there.
 */
type Piece = { header: string; texts: Text[] | null };

/** Takes an array, not rest parameters: a tool result can have more lines than a call takes. */
function piece(header: string, texts: Text[]): Piece {
  return { header, texts };
}

function omitted(header: string): Piece {
  return { header, texts: null };
}

/**
 * One scanned unit of a request. `body` is null for omitted content, such as an attachment, which
 * is represented only by its header.
 */
export type RequestSegment = { header: string; body: string | null };

/**
 * `context` is what configures the model rather than the conversation: tool definitions, output
 * formats, and the system prompt. It rarely changes within a session and is scanned and cached as
 * a whole. `conversation` is the message history, which grows request by request.
 */
export type RequestScanParts = {
  context: RequestSegment[];
  conversation: RequestSegment[];
};

/** Tool inputs and schemas are scanned as the JSON the model reads. */
function jsonText(value: unknown): Text {
  if (typeof value === 'string') return value;
  if (value === null || typeof value !== 'object') return undefined;
  return JSON.stringify(value);
}

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/**
 * Clients can send part, item, and tool types newer than the SDK types. Rather than dropping them,
 * scan the fields that carry model-visible text across the APIs, under a header naming the type.
 */
function unrecognized(role: string | null, value: never): Piece[] {
  const type = jsonType(value);
  return [piece(role ? `${role} ${type}` : type, jsonTexts(value))];
}

function jsonType(value: JsonValue): string {
  return typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    typeof value.type === 'string'
    ? value.type
    : 'content';
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

function toolCall(role: string, name: Text, input: Text): Piece {
  return piece(name ? `${role} tool call: ${name}` : `${role} tool call`, [input]);
}

function toolDefinition(name: Text, texts: Text[]): Piece {
  return piece(name ? `tool definition: ${name}` : 'tool definition', texts);
}

function namedFile(header: string, filename: Text): Piece {
  return omitted(filename ? `${header} "${filename}"` : header);
}

type ChatContentPart =
  | OpenAI.Chat.ChatCompletionContentPart
  | OpenAI.Chat.ChatCompletionContentPartRefusal;

function chatPartPieces(role: string, part: ChatContentPart): Piece[] {
  switch (part.type) {
    case 'text':
      return [piece(role, [part.text])];
    case 'refusal':
      return [piece(`${role} refusal`, [part.refusal])];
    case 'image_url':
      return [omitted(`${role} image`)];
    case 'input_audio':
      return [omitted(`${role} audio`)];
    case 'file':
      return [namedFile(`${role} file`, part.file.filename)];
    default:
      return unrecognized(role, part);
  }
}

function chatContentPieces(
  role: string,
  content: string | ChatContentPart[] | null | undefined
): Piece[] {
  if (typeof content === 'string') return [piece(role, [content])];
  return content ? content.flatMap(part => chatPartPieces(role, part)) : [];
}

/** Summaries restate the raw reasoning, and encrypted reasoning cannot be read. */
function reasoningDetailTexts(detail: ReasoningDetailUnion): Text[] {
  switch (detail.type) {
    case 'reasoning.text':
      return [detail.text];
    case 'reasoning.summary':
    case 'reasoning.encrypted':
      return [];
    default:
      return jsonTexts(detail satisfies never);
  }
}

/** Providers often send the same reasoning in several fields, so identical copies are scanned once. */
function chatReasoning(message: MessageWithReasoning): Piece {
  const texts = [
    message.reasoning,
    message.reasoning_content,
    (message.reasoning_details ?? []).flatMap(reasoningDetailTexts).join(''),
  ].map(text => text?.trim());
  return piece('assistant reasoning', [...new Set(texts)]);
}

function chatToolCallPiece(call: OpenAI.Chat.ChatCompletionMessageToolCall): Piece[] {
  switch (call.type) {
    case 'function':
      return [toolCall('assistant', call.function.name, call.function.arguments)];
    case 'custom':
      return [toolCall('assistant', call.custom.name, call.custom.input)];
    default:
      return unrecognized('assistant', call);
  }
}

type ChatMessage = OpenAI.Chat.ChatCompletionMessageParam & MessageWithReasoning;

function chatMessagePieces(message: ChatMessage): Piece[] {
  switch (message.role) {
    case 'tool':
      return chatContentPieces('tool result', message.content);
    case 'function':
      return [piece(`function result: ${message.name}`, [message.content])];
    case 'system':
    case 'developer':
    case 'user':
      return chatContentPieces(message.role, message.content);
    case 'assistant':
      return [
        chatReasoning(message),
        ...chatContentPieces('assistant', message.content),
        piece('assistant refusal', [message.refusal]),
        ...(message.function_call
          ? [toolCall('assistant', message.function_call.name, message.function_call.arguments)]
          : []),
        ...(message.tool_calls ?? []).flatMap(chatToolCallPiece),
      ];
    default:
      return unrecognized(null, message);
  }
}

function chatToolDefinitionPieces(tool: OpenAI.Chat.ChatCompletionTool): Piece[] {
  switch (tool.type) {
    case 'function':
      return [
        toolDefinition(tool.function.name, [
          tool.function.description,
          jsonText(tool.function.parameters),
        ]),
      ];
    case 'custom': {
      const { format } = tool.custom;
      return [
        toolDefinition(tool.custom.name, [
          tool.custom.description,
          format?.type === 'grammar' ? format.grammar.definition : undefined,
        ]),
      ];
    }
    default:
      return unrecognized('tool definition', tool);
  }
}

function chatResponseFormatPieces(
  format: OpenRouterChatCompletionRequest['response_format']
): Piece[] {
  if (format?.type !== 'json_schema') return [];
  const { name, description, schema } = format.json_schema;
  return [piece('response format', [name, description, jsonText(schema)])];
}

function isInstructionRole(role: unknown): boolean {
  return role === 'system' || role === 'developer';
}

/** The system prompt is the run of system and developer messages that opens the conversation. */
function leadingInstructionCount<T>(items: readonly T[], isInstruction: (item: T) => boolean) {
  const index = items.findIndex(item => !isInstruction(item));
  return index === -1 ? items.length : index;
}

function chatCompletionsParts(body: OpenRouterChatCompletionRequest): ScanPieces {
  const instructions = leadingInstructionCount(body.messages, message =>
    isInstructionRole(message.role)
  );
  return {
    context: [
      ...body.messages.slice(0, instructions).map(chatMessagePieces),
      ...(body.tools ?? []).map(chatToolDefinitionPieces),
      ...(body.functions ?? []).map(fn => [
        toolDefinition(fn.name, [fn.description, jsonText(fn.parameters)]),
      ]),
      chatResponseFormatPieces(body.response_format),
    ],
    conversation: body.messages.slice(instructions).map(chatMessagePieces),
  };
}

type AnthropicBlock = Anthropic.Beta.BetaContentBlockParam;

function anthropicTextBlocksTexts(blocks: Anthropic.Beta.BetaTextBlockParam[]): Text[] {
  return blocks.map(block => block.text);
}

function anthropicDocumentPieces(
  header: string,
  document: Anthropic.Beta.BetaRequestDocumentBlock
): Piece[] {
  const { source } = document;
  const texts: Text[] = [document.title, document.context];
  switch (source.type) {
    case 'text':
      return [piece(header, [...texts, source.data])];
    case 'content':
      return [
        piece(header, [
          ...texts,
          ...(typeof source.content === 'string'
            ? [source.content]
            : source.content.map(part => (part.type === 'text' ? part.text : undefined))),
        ]),
        ...(typeof source.content === 'string'
          ? []
          : source.content.flatMap(part =>
              part.type === 'image' ? [omitted(`${header} image`)] : []
            )),
      ];
    default:
      return [piece(header, texts), omitted(header)];
  }
}

function anthropicSearchResultPiece(
  header: string,
  result: Anthropic.Beta.BetaSearchResultBlockParam
): Piece {
  return piece(header, [result.title, ...anthropicTextBlocksTexts(result.content)]);
}

type AnthropicToolResultContent = NonNullable<Anthropic.Beta.BetaToolResultBlockParam['content']>;

function anthropicToolResultPieces(content: AnthropicToolResultContent | undefined): Piece[] {
  const header = 'tool result';
  if (typeof content === 'string') return [piece(header, [content])];
  return (content ?? []).flatMap(part => {
    switch (part.type) {
      case 'text':
        return [piece(header, [part.text])];
      case 'document':
        return anthropicDocumentPieces(`${header} document`, part);
      case 'search_result':
        return [anthropicSearchResultPiece(`${header} search result`, part)];
      case 'image':
        return [omitted(`${header} image`)];
      case 'tool_reference':
        return [];
      default:
        return unrecognized(header, part);
    }
  });
}

function anthropicCodeExecutionPieces(
  result:
    | Anthropic.Beta.BetaCodeExecutionToolResultBlockParam['content']
    | Anthropic.Beta.BetaBashCodeExecutionToolResultBlockParam['content']
): Piece[] {
  const header = 'code execution result';
  switch (result.type) {
    case 'code_execution_result':
    case 'bash_code_execution_result':
      return [piece(header, [result.stdout, result.stderr])];
    case 'encrypted_code_execution_result':
      return [piece(header, [result.stderr])];
    case 'code_execution_tool_result_error':
    case 'bash_code_execution_tool_result_error':
      return [];
    default:
      return unrecognized(header, result);
  }
}

function anthropicTextEditorPieces(
  result: Anthropic.Beta.BetaTextEditorCodeExecutionToolResultBlockParam['content']
): Piece[] {
  const header = 'text editor result';
  switch (result.type) {
    case 'text_editor_code_execution_view_result':
      return [piece(header, [result.content])];
    case 'text_editor_code_execution_str_replace_result':
      return [piece(header, result.lines ?? [])];
    case 'text_editor_code_execution_tool_result_error':
      return [piece(header, [result.error_message])];
    case 'text_editor_code_execution_create_result':
      return [];
    default:
      return unrecognized(header, result);
  }
}

function anthropicBlockPieces(role: string, block: AnthropicBlock): Piece[] {
  switch (block.type) {
    case 'text':
      return [piece(role, [block.text])];
    case 'thinking':
      return [piece(`${role} reasoning`, [block.thinking])];
    case 'tool_use':
    case 'server_tool_use':
    case 'mcp_tool_use':
      return [toolCall(role, block.name, jsonText(block.input))];
    case 'document':
      return anthropicDocumentPieces(`${role} document`, block);
    case 'compaction':
      return [piece('compaction summary', [block.content])];
    case 'mid_conv_system':
      return [piece('system', anthropicTextBlocksTexts(block.content))];
    case 'tool_result':
    case 'mcp_tool_result':
      return anthropicToolResultPieces(block.content);
    case 'search_result':
      return [anthropicSearchResultPiece(`${role} search result`, block)];
    case 'web_search_tool_result':
      return Array.isArray(block.content)
        ? [
            piece(
              'web search result',
              block.content.map(result => result.title)
            ),
          ]
        : [];
    case 'web_fetch_tool_result':
      return block.content.type === 'web_fetch_result'
        ? anthropicDocumentPieces('web fetch result', block.content.content)
        : [];
    case 'code_execution_tool_result':
    case 'bash_code_execution_tool_result':
      return anthropicCodeExecutionPieces(block.content);
    case 'text_editor_code_execution_tool_result':
      return anthropicTextEditorPieces(block.content);
    case 'tool_search_tool_result':
      return block.content.type === 'tool_search_tool_result_error'
        ? [piece('tool search result', [block.content.error_message])]
        : [];
    case 'advisor_tool_result':
      return block.content.type === 'advisor_result'
        ? [piece('advisor result', [block.content.text])]
        : [];
    case 'image':
      return [omitted(`${role} image`)];
    case 'container_upload':
      return [omitted(`${role} file`)];
    case 'redacted_thinking':
    case 'fallback':
      return [];
    default:
      return unrecognized(role, block);
  }
}

function anthropicMessagePieces(message: Anthropic.Beta.BetaMessageParam): Piece[] {
  return typeof message.content === 'string'
    ? [piece(message.role, [message.content])]
    : message.content.flatMap(block => anthropicBlockPieces(message.role, block));
}

function anthropicToolDefinitionPiece(tool: Anthropic.Beta.BetaToolUnion): Piece {
  return toolDefinition('name' in tool ? tool.name : undefined, [
    'description' in tool ? tool.description : undefined,
    'input_schema' in tool ? jsonText(tool.input_schema) : undefined,
    'input_examples' in tool ? jsonText(tool.input_examples) : undefined,
  ]);
}

type AnthropicTextSources = Pick<
  Anthropic.Beta.MessageCreateParams,
  'system' | 'messages' | 'tools' | 'output_config' | 'output_format'
>;

function messagesParts(request: GatewayMessagesRequest): ScanPieces {
  const body: AnthropicTextSources = request;
  const { system } = body;
  return {
    context: [
      [
        piece(
          'system',
          typeof system === 'string' ? [system] : anthropicTextBlocksTexts(system ?? [])
        ),
      ],
      ...(body.tools ?? []).map(tool => [anthropicToolDefinitionPiece(tool)]),
      [
        piece('response format', [
          jsonText(body.output_format?.schema),
          jsonText(body.output_config?.format?.schema),
        ]),
      ],
    ],
    conversation: body.messages.map(anthropicMessagePieces),
  };
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

function responsesToolDefinitionPieces(tool: ResponsesTool): Piece[] {
  switch (tool.type) {
    case 'function':
      return [
        toolDefinition(tool.name, [
          tool.description,
          jsonText(tool.parameters),
          jsonText(tool.output_schema),
        ]),
      ];
    case 'custom':
      return [toolDefinition(tool.name, [tool.description, ...responsesFormatTexts(tool.format)])];
    case 'namespace':
      return [
        toolDefinition(tool.name, [tool.description]),
        ...tool.tools.flatMap(responsesToolDefinitionPieces),
      ];
    case 'tool_search':
      return [toolDefinition('tool_search', [tool.description, jsonText(tool.parameters)])];
    case 'mcp':
      return [toolDefinition(`MCP server ${tool.server_label}`, [tool.server_description])];
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
      return unrecognized('tool definition', tool);
  }
}

type ResponsesMessagePart =
  | OpenAI.Responses.ResponseInputContent
  | OpenAI.Responses.ResponseFunctionCallOutputItem
  | OpenAI.Responses.ResponseOutputText
  | OpenAI.Responses.ResponseOutputRefusal;

function responsesPartPieces(header: string, part: ResponsesMessagePart): Piece[] {
  switch (part.type) {
    case 'input_text':
    case 'output_text':
      return [piece(header, [part.text])];
    case 'refusal':
      return [piece(`${header} refusal`, [part.refusal])];
    case 'input_image':
      return [omitted(`${header} image`)];
    case 'input_file':
      return [namedFile(`${header} file`, part.filename)];
    default:
      return unrecognized(header, part);
  }
}

function responsesContentPieces(header: string, content: string | ResponsesMessagePart[]): Piece[] {
  return typeof content === 'string'
    ? [piece(header, [content])]
    : content.flatMap(part => responsesPartPieces(header, part));
}

type ComputerAction = NonNullable<OpenAI.Responses.ResponseComputerToolCall['action']>;

function computerActionTexts(action: ComputerAction): Text[] {
  return action.type === 'type' ? [action.text] : [];
}

function responsesItemPieces(item: OpenAI.Responses.ResponseInputItem): Piece[] {
  switch (item.type) {
    case undefined:
    case null:
    case 'message':
      return 'content' in item ? responsesContentPieces(item.role, item.content) : [];
    case 'reasoning':
      return [
        piece(
          'assistant reasoning',
          (item.content ?? []).map(content => content.text)
        ),
      ];
    case 'function_call':
      return [toolCall('assistant', item.name, item.arguments)];
    case 'custom_tool_call':
      return [toolCall('assistant', item.name, item.input)];
    case 'mcp_approval_request':
      return [piece(`assistant MCP approval request: ${item.name}`, [item.arguments])];
    case 'mcp_approval_response':
      return [piece('MCP approval response', [item.reason])];
    case 'mcp_call':
      return [
        toolCall('assistant MCP', item.name, item.arguments),
        piece('MCP tool result', [item.output, item.error]),
      ];
    case 'tool_search_call':
      return [toolCall('assistant', 'tool_search', jsonText(item.arguments))];
    case 'file_search_call':
      return [
        toolCall('assistant', 'file_search', item.queries.join('\n')),
        piece(
          'file search result',
          (item.results ?? []).map(result => result.text)
        ),
      ];
    case 'web_search_call':
      return item.action.type === 'search'
        ? [
            toolCall(
              'assistant',
              'web_search',
              [item.action.query, ...(item.action.queries ?? [])].join('\n')
            ),
          ]
        : [];
    case 'computer_call':
      return [
        piece('assistant computer call', [
          ...(item.action ? computerActionTexts(item.action) : []),
          ...(item.actions ?? []).flatMap(computerActionTexts),
        ]),
      ];
    case 'code_interpreter_call':
      return [
        toolCall('assistant', 'code_interpreter', item.code),
        piece(
          'code interpreter result',
          (item.outputs ?? []).map(output => (output.type === 'logs' ? output.logs : undefined))
        ),
        ...(item.outputs ?? []).flatMap(output =>
          output.type === 'image' ? [omitted('code interpreter result image')] : []
        ),
      ];
    case 'local_shell_call':
      return [toolCall('assistant', 'local_shell', item.action.command.join(' '))];
    case 'shell_call':
      return [toolCall('assistant', 'shell', item.action.commands.join('\n'))];
    case 'apply_patch_call':
      return [
        toolCall(
          'assistant',
          'apply_patch',
          'diff' in item.operation
            ? `${item.operation.path}\n${item.operation.diff}`
            : item.operation.path
        ),
      ];
    case 'program':
      return [piece('assistant program', [item.code])];
    case 'additional_tools':
      return item.tools.flatMap(responsesToolDefinitionPieces);
    case 'function_call_output':
    case 'custom_tool_call_output':
      return responsesContentPieces('tool result', item.output);
    case 'local_shell_call_output':
    case 'apply_patch_call_output':
      return [piece('tool result', [item.output])];
    case 'shell_call_output':
      return [
        piece(
          'tool result',
          item.output.flatMap(output => [output.stdout, output.stderr])
        ),
      ];
    case 'program_output':
      return [piece('program result', [item.result])];
    case 'mcp_list_tools':
      return [
        ...item.tools.map(tool =>
          toolDefinition(tool.name, [tool.description, jsonText(tool.input_schema)])
        ),
        piece('MCP tool list error', [item.error]),
      ];
    case 'tool_search_output':
      return item.tools.flatMap(responsesToolDefinitionPieces);
    case 'computer_call_output':
      return [omitted('computer screenshot')];
    case 'image_generation_call':
      return [omitted('assistant generated image')];
    case 'compaction':
    case 'compaction_trigger':
    case 'item_reference':
      return [];
    default:
      return unrecognized(null, item);
  }
}

function isInstructionItem(item: OpenAI.Responses.ResponseInputItem): boolean {
  return (item.type === undefined || item.type === null || item.type === 'message') &&
    'role' in item
    ? isInstructionRole(item.role)
    : false;
}

function responsesParts(body: GatewayResponsesRequest): ScanPieces {
  const { input } = body;
  const items = typeof input === 'string' ? [] : (input ?? []);
  const instructions = leadingInstructionCount(items, isInstructionItem);
  return {
    context: [
      [piece('instructions', [body.instructions])],
      ...items.slice(0, instructions).map(responsesItemPieces),
      ...(body.tools ?? []).map(responsesToolDefinitionPieces),
      [piece('response format', responsesFormatTexts(body.text?.format))],
    ],
    conversation:
      typeof input === 'string'
        ? [[piece('user', [input])]]
        : items.slice(instructions).map(responsesItemPieces),
  };
}

/** Pieces grouped by the tool definition, message, or input item they came from. */
type ScanPieces = { context: Piece[][]; conversation: Piece[][] };

function scanPieces(request: GatewayRequest): ScanPieces {
  switch (request.kind) {
    case 'chat_completions':
      return chatCompletionsParts(request.body);
    case 'messages':
      return messagesParts(request.body);
    case 'responses':
      return responsesParts(request.body);
  }
}

export const SEGMENT_SEPARATOR = '\n\n';

export function joinSegments(segments: string[]): string {
  return segments.join(SEGMENT_SEPARATOR);
}

export function segmentHeaderLine(header: string): string {
  return `[${header}]`;
}

export function renderSegment({ header, body }: RequestSegment): string {
  return body === null ? `[${header} omitted]` : `${segmentHeaderLine(header)}\n${body}`;
}

/**
 * Pieces of one message are segments of their own; consecutive pieces with the same header, such as
 * two text parts, are merged.
 */
function messageSegments(pieces: Piece[]): RequestSegment[] {
  const groups: { header: string; texts: string[] | null }[] = [];
  for (const { header, texts } of pieces) {
    const trimmed =
      texts &&
      texts.flatMap(text => {
        const each = text?.trim();
        return each ? [each] : [];
      });
    if (trimmed?.length === 0) continue;
    const previous = groups.at(-1);
    if (previous?.texts && trimmed && previous.header === header) {
      for (const text of trimmed) previous.texts.push(text);
    } else {
      groups.push({ header, texts: trimmed });
    }
  }
  return groups.map(({ header, texts }) => ({ header, body: texts && joinSegments(texts) }));
}

/**
 * Every request can rewrite history, including assistant and system messages. Scan the full
 * conversation, including all textual tool results, rather than trusting earlier turns.
 * Attachments such as images and files are not scanned but are represented by an omission marker.
 * Encrypted content, reasoning summaries, and transport settings are never scanned.
 */
export function extractRequestParts(request: GatewayRequest): RequestScanParts {
  const { context, conversation } = scanPieces(request);
  return {
    context: context.flatMap(messageSegments),
    conversation: conversation.flatMap(messageSegments),
  };
}
