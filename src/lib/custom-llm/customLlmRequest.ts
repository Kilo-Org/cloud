import type {
  OpenRouterChatCompletionRequest,
  OpenRouterReasoningConfig,
} from '@/lib/providers/openrouter/types';
import { createAnthropic } from '@ai-sdk/anthropic';
import type { AnthropicProviderOptions } from '@ai-sdk/anthropic';
import {
  APICallError,
  generateText,
  jsonSchema,
  streamText,
  type ModelMessage,
  type TextStreamPart,
  type ToolChoice,
  type ToolSet,
} from 'ai';
import { NextResponse } from 'next/server';
import type {
  ChatCompletionAssistantMessageParam,
  ChatCompletionContentPart,
  OpenRouterChatCompletionsInput,
} from './openrouter-chat-completions-input';
import { ReasoningDetailType } from './reasoning-details';
import type { ReasoningDetailUnion } from './reasoning-details';
import type { OpenRouterStreamChatCompletionChunkSchema } from './schemas';
import type * as z from 'zod';

type ChatCompletionChunk = z.infer<typeof OpenRouterStreamChatCompletionChunkSchema>;

function convertMessages(messages: OpenRouterChatCompletionsInput): ModelMessage[] {
  // Build tool call ID → name mapping so tool result messages can reference the tool name
  const toolNameByCallId = new Map<string, string>();
  for (const msg of messages) {
    if (msg.role === 'assistant' && msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        toolNameByCallId.set(tc.id, tc.function.name);
      }
    }
  }

  return messages.map((msg): ModelMessage => {
    switch (msg.role) {
      case 'system':
        return {
          role: 'system',
          content: msg.content.map(part => part.text).join(''),
        };

      case 'user':
        return {
          role: 'user',
          content:
            typeof msg.content === 'string' ? msg.content : msg.content.map(convertUserContentPart),
        };

      case 'assistant':
        return {
          role: 'assistant',
          content: convertAssistantContent(msg),
        };

      case 'tool':
        return {
          role: 'tool',
          content: [
            {
              type: 'tool-result',
              toolCallId: msg.tool_call_id,
              toolName: toolNameByCallId.get(msg.tool_call_id) ?? '',
              output: convertToolOutput(msg.content),
            },
          ],
        };
    }
  });
}

function convertUserContentPart(part: ChatCompletionContentPart) {
  switch (part.type) {
    case 'text':
      return { type: 'text' as const, text: part.text };

    case 'image_url':
      return { type: 'image' as const, image: new URL(part.image_url.url) };

    case 'file':
      return {
        type: 'file' as const,
        data: part.file.file_data ?? '',
        filename: part.file.filename,
        mediaType: parseDataUrl(part.file.file_data ?? '')?.mediaType ?? 'application/octet-stream',
      };

    case 'input_audio':
      return {
        type: 'file' as const,
        data: part.input_audio.data,
        mediaType: audioFormatToMediaType(part.input_audio.format),
      };
  }
}

type ToolOutputContentPart =
  | { type: 'text'; text: string }
  | { type: 'media'; data: string; mediaType: string };

function convertToolOutput(content: string | Array<ChatCompletionContentPart>) {
  if (typeof content === 'string') {
    return { type: 'text' as const, value: content };
  }
  const parts: ToolOutputContentPart[] = content.map(convertToolOutputPart);
  return { type: 'content' as const, value: parts };
}

function convertToolOutputPart(part: ChatCompletionContentPart): ToolOutputContentPart {
  switch (part.type) {
    case 'text':
      return { type: 'text', text: part.text };

    case 'image_url': {
      const parsed = parseDataUrl(part.image_url.url);
      if (parsed) return { type: 'media', data: parsed.data, mediaType: parsed.mediaType };
      // Regular URL: pass as text since content output requires base64 data
      return { type: 'text', text: part.image_url.url };
    }

    case 'file': {
      const parsed = part.file.file_data ? parseDataUrl(part.file.file_data) : null;
      if (parsed) return { type: 'media', data: parsed.data, mediaType: parsed.mediaType };
      return { type: 'text', text: part.file.file_data ?? '' };
    }

    case 'input_audio':
      return {
        type: 'media',
        data: part.input_audio.data,
        mediaType: audioFormatToMediaType(part.input_audio.format),
      };
  }
}

function parseDataUrl(url: string): { data: string; mediaType: string } | null {
  const match = url.match(/^data:([^;]+);base64,(.+)$/);
  if (match) return { mediaType: match[1], data: match[2] };
  return null;
}

const AUDIO_MEDIA_TYPES: Record<string, string> = {
  wav: 'audio/wav',
  mp3: 'audio/mpeg',
  aiff: 'audio/aiff',
  aac: 'audio/aac',
  ogg: 'audio/ogg',
  flac: 'audio/flac',
  m4a: 'audio/mp4',
  pcm16: 'audio/pcm',
  pcm24: 'audio/pcm',
};

function audioFormatToMediaType(format: string): string {
  return AUDIO_MEDIA_TYPES[format] ?? 'application/octet-stream';
}

function reasoningDetailToText(detail: ReasoningDetailUnion): string | null {
  switch (detail.type) {
    case ReasoningDetailType.Text:
      return detail.text ?? null;
    case ReasoningDetailType.Summary:
      return detail.summary;
    case ReasoningDetailType.Encrypted:
      return null;
  }
}

function convertAssistantContent(msg: ChatCompletionAssistantMessageParam) {
  const parts: Array<
    | { type: 'text'; text: string }
    | { type: 'reasoning'; text: string }
    | { type: 'tool-call'; toolCallId: string; toolName: string; input: unknown }
  > = [];

  // Prefer structured reasoning_details over flat reasoning string
  if (msg.reasoning_details && msg.reasoning_details.length > 0) {
    for (const detail of msg.reasoning_details) {
      const text = reasoningDetailToText(detail);
      if (text) {
        parts.push({ type: 'reasoning', text });
      }
    }
  } else if (msg.reasoning) {
    parts.push({ type: 'reasoning', text: msg.reasoning });
  }

  if (msg.content) {
    parts.push({ type: 'text', text: msg.content });
  }

  if (msg.tool_calls) {
    for (const tc of msg.tool_calls) {
      parts.push({
        type: 'tool-call',
        toolCallId: tc.id,
        toolName: tc.function.name,
        input: safeJsonParse(tc.function.arguments),
      });
    }
  }

  if (parts.length === 1 && parts[0].type === 'text') {
    return parts[0].text;
  }

  return parts.length > 0 ? parts : '';
}

function safeJsonParse(str: string): unknown {
  try {
    return JSON.parse(str);
  } catch {
    return str;
  }
}

function convertTools(tools: OpenRouterChatCompletionRequest['tools']): ToolSet | undefined {
  if (!tools || tools.length === 0) return undefined;

  const result: ToolSet = {};
  for (const t of tools) {
    if (t.type !== 'function') continue;
    result[t.function.name] = {
      description: t.function.description,
      inputSchema: jsonSchema(t.function.parameters ?? { type: 'object' }),
    };
  }
  return result;
}

// Stream part → OpenRouter SSE chunk conversion

const FINISH_REASON_MAP: Record<string, string> = {
  stop: 'stop',
  length: 'length',
  'content-filter': 'content_filter',
  'tool-calls': 'tool_calls',
  error: 'error',
  other: 'stop',
};

function createStreamPartConverter() {
  const toolCallIndices = new Map<string, number>();
  let nextToolIndex = 0;

  return function convertStreamPartToChunk(
    part: TextStreamPart<ToolSet>
  ): ChatCompletionChunk | null {
    switch (part.type) {
      case 'text-delta':
        return { choices: [{ delta: { content: part.text } }] };

      case 'reasoning-delta':
        return {
          choices: [
            {
              delta: {
                reasoning: part.text,
                reasoning_details: [{ type: ReasoningDetailType.Text, text: part.text }],
              },
            },
          ],
        };

      case 'tool-input-start': {
        const index = nextToolIndex++;
        toolCallIndices.set(part.id, index);
        return {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index,
                    id: part.id,
                    type: 'function' as const,
                    function: { name: part.toolName },
                  },
                ],
              },
            },
          ],
        };
      }

      case 'tool-input-delta': {
        const index = toolCallIndices.get(part.id) ?? 0;
        return {
          choices: [
            {
              delta: {
                tool_calls: [{ index, function: { arguments: part.delta } }],
              },
            },
          ],
        };
      }

      case 'tool-call': {
        // Handle non-streaming tool calls (emitted as a single event)
        if (toolCallIndices.has(part.toolCallId)) return null;
        const index = nextToolIndex++;
        return {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index,
                    id: part.toolCallId,
                    type: 'function' as const,
                    function: {
                      name: part.toolName,
                      arguments: JSON.stringify(part.input),
                    },
                  },
                ],
              },
            },
          ],
        };
      }

      case 'finish-step':
        return {
          choices: [
            {
              delta: {},
              finish_reason: FINISH_REASON_MAP[part.finishReason] ?? 'stop',
            },
          ],
          usage: {
            prompt_tokens: part.usage.inputTokens ?? 0,
            completion_tokens: part.usage.outputTokens ?? 0,
            total_tokens: part.usage.totalTokens ?? 0,
          },
        };

      default:
        return null;
    }
  };
}

function convertToolChoice(
  toolChoice: OpenRouterChatCompletionRequest['tool_choice']
): ToolChoice<ToolSet> | undefined {
  if (toolChoice === undefined || toolChoice === null) return undefined;
  if (toolChoice === 'none' || toolChoice === 'auto' || toolChoice === 'required') {
    return toolChoice;
  }
  if (typeof toolChoice === 'object' && 'type' in toolChoice && toolChoice.type === 'function') {
    return { type: 'tool', toolName: toolChoice.function.name };
  }
  return undefined;
}

function errorResponse(status: number, message: string) {
  return NextResponse.json({ error: { message, code: status, type: 'error' } }, { status });
}

function buildCommonParams(messages: ModelMessage[], request: OpenRouterChatCompletionRequest) {
  return {
    messages,
    tools: convertTools(request.tools),
    toolChoice: convertToolChoice(request.tool_choice),
    maxOutputTokens: request.max_tokens ?? request.max_completion_tokens ?? undefined,
    headers: {
      'anthropic-beta': 'context-1m-2025-08-07',
    },
    providerOptions: {
      anthropic: {
        thinking: { type: 'adaptive' },
      } satisfies AnthropicProviderOptions,
    },
  };
}

function convertGenerateResultToResponse(result: Awaited<ReturnType<typeof generateText>>) {
  const toolCalls = result.toolCalls.map((tc, i) => ({
    id: tc.toolCallId,
    type: 'function' as const,
    index: i,
    function: {
      name: tc.toolName,
      arguments: JSON.stringify(tc.input),
    },
  }));

  return {
    choices: [
      {
        message: {
          role: 'assistant' as const,
          content: result.text || null,
          ...(result.reasoningText ? { reasoning: result.reasoningText } : {}),
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        },
        finish_reason: FINISH_REASON_MAP[result.finishReason] ?? 'stop',
        index: 0,
      },
    ],
    usage: {
      prompt_tokens: result.usage.inputTokens ?? 0,
      completion_tokens: result.usage.outputTokens ?? 0,
      total_tokens: result.usage.totalTokens ?? 0,
    },
  };
}

export async function customLlmRequest(
  requestedModel: string,
  request: OpenRouterChatCompletionRequest
) {
  let messages: ModelMessage[];
  try {
    messages = convertMessages(request.messages as OpenRouterChatCompletionsInput);
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Invalid messages';
    return errorResponse(400, msg);
  }

  const provider = createAnthropic({
    apiKey: 'placeholder',
  });

  const model = provider('placeholder');
  const commonParams = buildCommonParams(messages, request);

  // Non-streaming response
  if (!request.stream) {
    try {
      const result = await generateText({ model, ...commonParams });
      return NextResponse.json(convertGenerateResultToResponse(result));
    } catch (e) {
      const status = APICallError.isInstance(e) ? (e.statusCode ?? 500) : 500;
      const msg = e instanceof Error ? e.message : 'Generation failed';
      return errorResponse(status, msg);
    }
  }

  // Streaming response
  const result = streamText({ model, ...commonParams });

  const convertStreamPartToChunk = createStreamPartConverter();

  const stream = new ReadableStream({
    async start(controller) {
      try {
        for await (const chunk of result.fullStream) {
          const converted = convertStreamPartToChunk(chunk);
          if (converted) {
            controller.enqueue(`data: ${JSON.stringify(converted)}\n\n`);
          }
        }

        controller.enqueue('data: [DONE]\n\n');
      } catch (e) {
        const errorChunk = {
          error: {
            message: e instanceof Error ? e.message : 'Stream error',
            code: APICallError.isInstance(e) ? (e.statusCode ?? 500) : 500,
            ...(APICallError.isInstance(e) && e.responseBody
              ? { metadata: { raw: e.responseBody } }
              : {}),
            type: 'error',
          },
        };
        controller.enqueue(`data: ${JSON.stringify(errorChunk)}\n\n`);
      } finally {
        controller.close();
      }
    },
  });

  return new NextResponse(stream, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream',
    },
  });
}
