import type { OpenRouterChatCompletionRequest } from '@/lib/providers/openrouter/types';
import { createAnthropic } from '@ai-sdk/anthropic';
import type { AnthropicProviderOptions } from '@ai-sdk/anthropic';
import {
  APICallError,
  generateText,
  jsonSchema,
  streamText,
  type ModelMessage,
  type TextPart,
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
import type { Phase } from './schemas';
import { PhaseSchema, type ChatCompletionChunk, type ChatCompletionChunkChoice } from './schemas';
import type { OpenAILanguageModelResponsesOptions } from '@ai-sdk/openai';
import { createOpenAI } from '@ai-sdk/openai';
import { debugSaveLog, inStreamDebugMode } from '@/lib/debugUtils';
import { ReasoningFormat } from '@/lib/ai-gateway/custom-llm/format';
import {
  CustomLlmExtraBodySchema,
  CustomLlmExtraHeadersSchema,
  InterleavedFormatSchema,
  ReasoningEffortSchema,
  VerbositySchema,
} from '@kilocode/db/schema-types';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type OpenAI from 'openai';
import { grok_code_fast_1_optimized_free_model } from '@/lib/providers/xai';
import PROVIDERS from '@/lib/providers/provider-definitions';

type CustomLlm = {
  public_id: string;
  display_name: string;
  context_length: number;
  max_completion_tokens: number;
  internal_id: string;
  provider: string;
  base_url: string;
  api_key: string;
  organization_ids: string[];
  supports_image_input?: boolean | null;
  force_reasoning?: boolean | null;
  opencode_settings?: Record<string, unknown> | null;
  extra_body?: Record<string, unknown> | null;
  extra_headers?: Record<string, string> | null;
  interleaved_format?: string | null;
};

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
  | TextPart
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

  // Attach phase as providerOptions on text parts so the AI SDK OpenAI provider
  // can forward it to the Responses API input items.
  if (msg.phase != null) {
    const phaseOpts = { openai: { phase: msg.phase } };
    for (const part of parts) {
      if (part.type === 'text') {
        part.providerOptions = phaseOpts;
      }
    }
    // If there are no text parts but phase is set, emit an empty text part to carry it.
    if (!parts.some(p => p.type === 'text')) {
      parts.unshift({ type: 'text', text: '', providerOptions: phaseOpts });
    }
    return parts;
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
      strict: (t.type === 'function' && t.function.strict) ?? undefined,
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

  return async function convertStreamPartToChunk(
    part: TextStreamPart<ToolSet>
  ): Promise<ChatCompletionChunk | null> {
    const id = responseId;
    switch (part.type) {
      case 'text-end': {
        const rawPhase = part.providerMetadata?.openai?.phase;
        const phase = PhaseSchema.safeParse(rawPhase).data;
        if (phase === undefined) return null;
        return {
          ...(id !== undefined ? { id } : {}),
          model,
          choices: [{ delta: { phase } }],
        };
      }

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
        const reasoningTokens = part.usage.outputTokenDetails.reasoningTokens;
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
            ...(reasoningTokens != null
              ? {
                  completion_tokens_details: {
                    reasoning_tokens: reasoningTokens,
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
  request: OpenRouterChatCompletionRequest,
  isLegacyExtension: boolean
) {
  const verbosity = VerbositySchema.safeParse(request.verbosity).data;
  const reasoningEffort = ReasoningEffortSchema.safeParse(request.reasoning?.effort).data;
  return {
    messages,
    tools: convertTools(request.tools),
    toolChoice: convertToolChoice(request.tool_choice),
    maxOutputTokens: request.max_completion_tokens ?? request.max_tokens ?? undefined,
    temperature: request.temperature ?? undefined,
    headers: {
      'anthropic-beta': 'context-1m-2025-08-07',
    },
    providerOptions: {
      anthropic: {
        thinking: { type: 'adaptive' },
        effort: verbosity,
        disableParallelToolUse: request.parallel_tool_calls === false || isLegacyExtension,
      } satisfies AnthropicProviderOptions,
      openai: {
        forceReasoning: (reasoningEffort !== 'none' && customLlm.force_reasoning) || undefined,
        reasoningSummary: 'auto',
        textVerbosity: verbosity === 'max' ? 'high' : verbosity,
        reasoningEffort: reasoningEffort,
        include: ['reasoning.encrypted_content'],
        parallelToolCalls: (request.parallel_tool_calls ?? true) && !isLegacyExtension,
        store: false,
        promptCacheKey: request.prompt_cache_key,
        safetyIdentifier: request.safety_identifier,
        user: request.user,
      } satisfies OpenAILanguageModelResponsesOptions,
    },
  };
}

function extractPhaseFromContent(
  content: Awaited<ReturnType<typeof generateText>>['content']
): Phase | undefined {
  for (const part of content) {
    if (part.type === 'text') {
      const phase = PhaseSchema.safeParse(part.providerMetadata?.openai?.phase).data;
      if (phase) return phase;
    }
  }
  return undefined;
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

  const phase = extractPhaseFromContent(result.content);

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
          ...(phase !== undefined ? { phase } : {}),
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
      ...(result.usage.outputTokenDetails.reasoningTokens != null
        ? {
            completion_tokens_details: {
              reasoning_tokens: result.usage.outputTokenDetails.reasoningTokens,
            },
          }
        : {}),
    },
  };
}

function createModel(customLlm: CustomLlm) {
  const extraHeaders = CustomLlmExtraHeadersSchema.safeParse(customLlm.extra_headers).data;
  if (customLlm.provider === 'anthropic') {
    const anthropic = createAnthropic({
      apiKey: customLlm.api_key,
      baseURL: customLlm.base_url,
      headers: extraHeaders,
    });
    return anthropic(customLlm.internal_id);
  }
  if (customLlm.provider === 'openai') {
    const openai = createOpenAI({
      apiKey: customLlm.api_key,
      baseURL: customLlm.base_url,
      headers: extraHeaders,
    });
    return openai(customLlm.internal_id);
  }
  if (customLlm.provider === 'openai-compatible') {
    const interleavedFormat =
      InterleavedFormatSchema.safeParse(customLlm.interleaved_format).data ??
      InterleavedFormatSchema.enum.reasoning_content;
    const openaiCompatible = createOpenAICompatible({
      name: 'openaiCompatible',
      apiKey: customLlm.api_key,
      baseURL: customLlm.base_url,
      headers: extraHeaders,
      transformRequestBody: body => {
        let messages = (body as OpenAI.ChatCompletionCreateParams).messages ?? [];
        if (interleavedFormat === InterleavedFormatSchema.enum.think) {
          messages = messages.map(msg => {
            if (
              msg.role !== 'assistant' ||
              !('reasoning_content' in msg) ||
              typeof msg.reasoning_content !== 'string'
            ) {
              return msg;
            }
            const think = '<think>' + msg.reasoning_content + '</think>';
            if (Array.isArray(msg.content)) {
              return {
                ...msg,
                content: [{ type: 'text', text: think }, ...msg.content],
                reasoning_content: undefined,
              };
            } else {
              return {
                ...msg,
                content: think + (msg.content ?? ''),
                reasoning_content: undefined,
              };
            }
          });
        }
        const extraBody = CustomLlmExtraBodySchema.safeParse(customLlm.extra_body).data;
        return { ...body, messages, ...extraBody };
      },
    });
    return openaiCompatible(customLlm.internal_id);
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

async function customLlmRequest(
  customLlm: CustomLlm,
  request: OpenRouterChatCompletionRequest,
  isLegacyExtension: boolean
) {
  const messages = request.messages as OpenRouterChatCompletionsInput;
  if (isLegacyExtension) {
    reverseLegacyExtensionHack(messages);
  }

  const model = createModel(customLlm);
  const commonParams = buildCommonParams(
    customLlm,
    convertMessages(messages),
    request,
    isLegacyExtension
  );

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
    debugSaveLog(JSON.stringify(commonParams, undefined, 2), 'request.ai-sdk.json');
    debugSaveLog(JSON.stringify((await result.request).body, undefined, 2), 'request.native.json');
  }

  const convertStreamPartToChunk = createStreamPartConverter(modelId);

  const debugGatewayChunks = new Array<unknown>();
  const debugAiSdkChunks = new Array<unknown>();
  const debugNativeChunks = new Array<unknown>();

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      try {
        for await (const chunk of result.fullStream) {
          if (inStreamDebugMode) {
            if (chunk.type === 'raw') {
              debugNativeChunks.push(chunk.rawValue);
            } else {
              debugAiSdkChunks.push(chunk);
            }
          }

          const converted = await convertStreamPartToChunk(chunk);
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
        debugLogChunks(debugAiSdkChunks, 'response.ai-sdk.jsonl');
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

export function grokCodeFastOptimizedRequest(
  request: OpenRouterChatCompletionRequest,
  isLegacyExtension: boolean
) {
  const model = grok_code_fast_1_optimized_free_model;
  const provider = PROVIDERS.MARTIAN;
  return customLlmRequest(
    {
      public_id: model.public_id,
      internal_id: model.internal_id,
      display_name: model.display_name,
      context_length: model.context_length,
      max_completion_tokens: model.max_completion_tokens,
      provider: 'openai', // xai doesn't support preserved reasoning currently: https://github.com/vercel/ai/issues/10542
      organization_ids: [],
      base_url: provider.apiUrl,
      api_key: provider.apiKey,
      supports_image_input: model.flags.includes('vision'),
      force_reasoning: true,
      opencode_settings: null,
      extra_body: null,
      extra_headers: null,
      interleaved_format: null,
    },
    request,
    isLegacyExtension
  );
}
