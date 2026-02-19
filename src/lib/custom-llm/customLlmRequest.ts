import type { OpenRouterChatCompletionRequest } from '@/lib/providers/openrouter/types';
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
import { ReasoningDetailType, type ReasoningDetailUnion } from './reasoning-details';
import {
  reasoningDetailsToAiSdkParts,
  reasoningOutputToDetails,
  extractSignature,
  extractEncryptedData,
  extractItemId,
  extractFormat,
  type AiSdkReasoningPart,
} from './reasoning-provider-metadata';
import type { ChatCompletionChunk, ChatCompletionChunkChoice } from './schemas';
import type { CustomLlm } from '@/db/schema';
import type { OpenAILanguageModelResponsesOptions } from '@ai-sdk/openai';
import { createOpenAI } from '@ai-sdk/openai';
import { createXai } from '@ai-sdk/xai';
import type { XaiLanguageModelResponsesOptions } from '@ai-sdk/xai';
import { debugSaveLog, inStreamDebugMode } from '@/lib/debugUtils';
import { ReasoningFormat } from '@/lib/custom-llm/format';

function convertMessages(messages: OpenRouterChatCompletionsInput): ModelMessage[] {
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
          content:
            typeof msg.content === 'string'
              ? msg.content
              : msg.content.map(part => part.text).join(''),
          providerOptions: {
            anthropic: { cacheControl: { type: 'ephemeral' } },
          },
        };

      case 'user': {
        const content =
          typeof msg.content === 'string' ? msg.content : msg.content.map(convertUserContentPart);
        return {
          role: 'user',
          content,
          ...(msg.cache_control && {
            providerOptions: { anthropic: { cacheControl: msg.cache_control } },
          }),
        };
      }

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
  const providerOptions = part.cache_control
    ? { anthropic: { cacheControl: part.cache_control } }
    : undefined;

  switch (part.type) {
    case 'text':
      return {
        type: 'text' as const,
        text: part.text,
        ...(providerOptions && { providerOptions }),
      };

    case 'image_url':
      return {
        type: 'image' as const,
        image: new URL(part.image_url.url),
        ...(providerOptions && { providerOptions }),
      };

    case 'file':
      return {
        type: 'file' as const,
        data: part.file.file_data ?? '',
        filename: part.file.filename,
        mediaType: parseDataUrl(part.file.file_data ?? '')?.mediaType ?? 'application/octet-stream',
        ...(providerOptions && { providerOptions }),
      };

    case 'input_audio':
      return {
        type: 'file' as const,
        data: part.input_audio.data,
        mediaType: audioFormatToMediaType(part.input_audio.format),
        ...(providerOptions && { providerOptions }),
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

type AssistantContentPart =
  | { type: 'text'; text: string }
  | AiSdkReasoningPart
  | { type: 'tool-call'; toolCallId: string; toolName: string; input: unknown };

function convertAssistantContent(msg: ChatCompletionAssistantMessageParam) {
  const parts: AssistantContentPart[] = [];

  if (msg.reasoning_details && msg.reasoning_details.length > 0) {
    for (const sdkPart of reasoningDetailsToAiSdkParts(msg.reasoning_details)) {
      parts.push(sdkPart);
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
        input: JSON.parse(tc.function.arguments),
      });
    }
  }

  if (parts.length === 1 && parts[0].type === 'text') {
    return parts[0].text;
  }

  return parts.length > 0 ? parts : '';
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

const FINISH_REASON_MAP: Record<string, string> = {
  stop: 'stop',
  length: 'length',
  'content-filter': 'content_filter',
  'tool-calls': 'tool_calls',
  error: 'error',
  other: 'stop',
};

function createStreamPartConverter(model: string) {
  const toolCallIndices = new Map<string, number>();
  let nextToolIndex = 0;
  let nextReasoningIndex = 0;
  let currentTextBlockIndex: number | null = null;
  let inReasoningBlock = false;
  let responseId: string | undefined;

  return function convertStreamPartToChunk(
    part: TextStreamPart<ToolSet>
  ): ChatCompletionChunk | null {
    const id = responseId;
    switch (part.type) {
      case 'text-delta':
        return {
          ...(id !== undefined ? { id } : {}),
          model,
          choices: [{ delta: { content: part.text } }],
        };

      case 'reasoning-start': {
        // Anthropic redacted_thinking: reasoning-start carries redactedData
        const encData = extractEncryptedData(part.providerMetadata);
        if (encData) {
          const itemId = extractItemId(part.providerMetadata);
          const format = extractFormat(part.providerMetadata);
          const index = nextReasoningIndex++;
          return {
            ...(id !== undefined ? { id } : {}),
            model,
            choices: [
              {
                delta: {
                  reasoning_details: [
                    {
                      type: ReasoningDetailType.Encrypted,
                      data: encData,
                      index,
                      ...(itemId ? { id: itemId } : {}),
                      ...(format ? { format } : {}),
                    },
                  ],
                },
              },
            ],
          };
        }
        inReasoningBlock = true;
        return null;
      }

      case 'reasoning-delta': {
        const details: ReasoningDetailUnion[] = [];
        const signature = extractSignature(part.providerMetadata);
        const format = extractFormat(part.providerMetadata);

        if (part.text) {
          if (inReasoningBlock) {
            currentTextBlockIndex = nextReasoningIndex++;
            inReasoningBlock = false;
          }
          const itemId = extractItemId(part.providerMetadata);
          details.push({
            type: ReasoningDetailType.Text,
            text: part.text,
            index: currentTextBlockIndex ?? 0,
            ...(signature ? { signature } : {}),
            ...(itemId ? { id: itemId } : {}),
            ...(format ? { format } : {}),
          });
        } else if (signature) {
          // Signature-only delta (Anthropic sends empty text + signature_delta)
          details.push({
            type: ReasoningDetailType.Text,
            text: '',
            signature,
            index: currentTextBlockIndex ?? 0,
            ...(format ? { format } : {}),
          });
        }

        if (details.length === 0) return null;

        return {
          ...(id !== undefined ? { id } : {}),
          model,
          choices: [
            {
              delta: {
                reasoning: part.text || '',
                reasoning_details: details,
              },
            },
          ],
        };
      }

      case 'reasoning-end': {
        // OpenAI/xAI: encrypted content may arrive on reasoning-end
        const encData = extractEncryptedData(part.providerMetadata);
        const signature = extractSignature(part.providerMetadata);

        if (!encData && !signature) return null;

        const details: ReasoningDetailUnion[] = [];
        const itemId = extractItemId(part.providerMetadata);
        const format = extractFormat(part.providerMetadata);

        if (encData) {
          const index = nextReasoningIndex++;
          details.push({
            type: ReasoningDetailType.Encrypted,
            data: encData,
            index,
            ...(itemId ? { id: itemId } : {}),
            ...(format ? { format } : {}),
          });
        }

        if (signature) {
          details.push({
            type: ReasoningDetailType.Text,
            text: '',
            signature,
            index: currentTextBlockIndex ?? 0,
            ...(itemId ? { id: itemId } : {}),
            ...(format ? { format } : {}),
          });
        }

        return {
          ...(id !== undefined ? { id } : {}),
          model,
          choices: [{ delta: { reasoning_details: details } }],
        };
      }

      case 'tool-input-start': {
        const index = nextToolIndex++;
        toolCallIndices.set(part.id, index);
        return {
          ...(id !== undefined ? { id } : {}),
          model,
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
          ...(id !== undefined ? { id } : {}),
          model,
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
          ...(id !== undefined ? { id } : {}),
          model,
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

      case 'finish-step': {
        responseId = part.response.id;
        const cacheReadTokens = part.usage.inputTokenDetails.cacheReadTokens;
        const cacheWriteTokens = part.usage.inputTokenDetails.cacheWriteTokens;
        return {
          id: responseId,
          model,
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
            ...(cacheReadTokens != null || cacheWriteTokens != null
              ? {
                  prompt_tokens_details: {
                    cached_tokens: cacheReadTokens ?? 0,
                    ...(cacheWriteTokens != null && { cache_write_tokens: cacheWriteTokens }),
                  },
                }
              : {}),
          },
        };
      }

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

function buildCommonParams(
  customLlm: CustomLlm,
  messages: ModelMessage[],
  request: OpenRouterChatCompletionRequest
) {
  const verbosity = customLlm.verbosity ?? request.verbosity ?? undefined;
  return {
    messages,
    tools: convertTools(request.tools),
    toolChoice: convertToolChoice(request.tool_choice),
    maxOutputTokens: request.max_completion_tokens ?? request.max_tokens ?? undefined,
    headers: {
      'anthropic-beta': 'context-1m-2025-08-07',
    },
    providerOptions: {
      anthropic: {
        thinking: { type: 'adaptive' },
        effort: verbosity,
        disableParallelToolUse: request.parallel_tool_calls === false,
      } satisfies AnthropicProviderOptions,
      openai: {
        reasoningSummary: 'auto',
        textVerbosity: verbosity === 'max' ? 'high' : verbosity,
        reasoningEffort:
          customLlm.reasoning_effort ?? request.reasoning?.effort ?? request.reasoning_effort,
        include: ['reasoning.encrypted_content'],
        parallelToolCalls: request.parallel_tool_calls,
        store: false,
      } satisfies OpenAILanguageModelResponsesOptions,
      xai: {
        store: false,
      } satisfies XaiLanguageModelResponsesOptions,
    },
  };
}

function convertGenerateResultToResponse(
  result: Awaited<ReturnType<typeof generateText>>,
  model: string
) {
  const toolCalls = result.toolCalls.map((tc, i) => ({
    id: tc.toolCallId,
    type: 'function' as const,
    index: i,
    function: {
      name: tc.toolName,
      arguments: JSON.stringify(tc.input),
    },
  }));

  const reasoning_details =
    result.reasoning.length > 0 ? reasoningOutputToDetails(result.reasoning) : undefined;

  return {
    id: result.response.id,
    model,
    choices: [
      {
        message: {
          role: 'assistant' as const,
          content: result.text || null,
          ...(result.reasoningText ? { reasoning: result.reasoningText } : {}),
          ...(reasoning_details ? { reasoning_details } : {}),
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
      ...(result.usage.inputTokenDetails.cacheReadTokens != null ||
      result.usage.inputTokenDetails.cacheWriteTokens != null
        ? {
            prompt_tokens_details: {
              cached_tokens: result.usage.inputTokenDetails.cacheReadTokens ?? 0,
              ...(result.usage.inputTokenDetails.cacheWriteTokens != null && {
                cache_write_tokens: result.usage.inputTokenDetails.cacheWriteTokens,
              }),
            },
          }
        : {}),
    },
  };
}

function createModel(customLlm: CustomLlm) {
  if (customLlm.provider === 'anthropic') {
    const anthropic = createAnthropic({
      apiKey: customLlm.api_key,
      baseURL: customLlm.base_url,
    });
    return anthropic(customLlm.internal_id);
  }
  if (customLlm.provider === 'openai') {
    const openai = createOpenAI({
      apiKey: customLlm.api_key,
      baseURL: customLlm.base_url,
    });
    return openai(customLlm.internal_id);
  }
  if (customLlm.provider === 'xai') {
    const xai = createXai({
      apiKey: customLlm.api_key,
      baseURL: customLlm.base_url,
    });
    return xai.responses(customLlm.internal_id);
  }
  throw new Error(`Unknown provider: ${customLlm.provider}`);
}

function debugLogChunks(chunks: unknown[], fileExtension: string) {
  if (chunks.length > 0) {
    debugSaveLog(chunks.map(chunk => JSON.stringify(chunk)).join('\n'), fileExtension);
  }
}

function reverseLegacyExtensionHack(messages: OpenRouterChatCompletionsInput) {
  for (const msg of messages) {
    if (msg.role === 'assistant') {
      for (const rd of msg.reasoning_details ?? []) {
        if (rd.format === ReasoningFormat.OpenAIResponsesV1_Obscured) {
          rd.format = ReasoningFormat.OpenAIResponsesV1;
        }
      }
    }
  }
}

function applyLegacyExtensionHack(choice: ChatCompletionChunkChoice | undefined) {
  for (const rd of choice?.delta?.reasoning_details ?? []) {
    if (rd.format === ReasoningFormat.OpenAIResponsesV1) {
      rd.format = ReasoningFormat.OpenAIResponsesV1_Obscured;
    }
  }
}

export async function customLlmRequest(
  customLlm: CustomLlm,
  request: OpenRouterChatCompletionRequest,
  isLegacyExtension: boolean
) {
  const messages = request.messages as OpenRouterChatCompletionsInput;
  if (isLegacyExtension) {
    reverseLegacyExtensionHack(messages);
  }

  const model = createModel(customLlm);
  const commonParams = buildCommonParams(customLlm, convertMessages(messages), request);

  const modelId = customLlm.public_id;

  if (!request.stream) {
    try {
      const result = await generateText({ model, ...commonParams });
      const convertedResponse = convertGenerateResultToResponse(result, modelId);

      if (inStreamDebugMode) {
        debugSaveLog(JSON.stringify(result.response.body, undefined, 2), 'response.native.json');
        debugSaveLog(JSON.stringify(convertedResponse, undefined, 2), 'response.gateway.json');
      }

      return NextResponse.json(convertedResponse);
    } catch (e) {
      console.error('Caught exception while processing non-streaming request', e);
      const status = APICallError.isInstance(e) ? (e.statusCode ?? 500) : 500;
      const msg = e instanceof Error ? e.message : 'Generation failed';
      return errorResponse(status, msg);
    }
  }

  const result = streamText({ model, ...commonParams, includeRawChunks: inStreamDebugMode });

  if (inStreamDebugMode) {
    debugSaveLog(JSON.stringify(request, undefined, 2), 'request.gateway.json');
    debugSaveLog(JSON.stringify((await result.request).body, undefined, 2), 'request.native.json');
  }

  const convertStreamPartToChunk = createStreamPartConverter(modelId);

  const debugGatewayChunks = new Array<unknown>();
  const debugNativeChunks = new Array<unknown>();

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      try {
        for await (const chunk of result.fullStream) {
          if (chunk.type === 'raw') {
            debugNativeChunks.push(chunk.rawValue);
          }

          const converted = convertStreamPartToChunk(chunk);
          if (converted) {
            if (isLegacyExtension) {
              applyLegacyExtensionHack((converted.choices as ChatCompletionChunkChoice[])[0]);
            }
            if (inStreamDebugMode) {
              debugGatewayChunks.push(converted);
            }
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(converted)}\n\n`));
          }
        }

        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      } catch (e) {
        console.error('Caught exception while processing streaming request', e);
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
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(errorChunk)}\n\n`));
      } finally {
        controller.close();
        debugLogChunks(debugGatewayChunks, 'response.gateway.jsonl');
        debugLogChunks(debugNativeChunks, 'response.native.jsonl');
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
