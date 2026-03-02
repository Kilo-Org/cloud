import type { CustomLlm } from '@kilocode/db/schema';
import { temp_phase } from '@kilocode/db/schema';
import { VerbositySchema, ReasoningEffortSchema } from '@kilocode/db/schema-types';
import { ReasoningDetailType } from '@kilocode/llm-shared';
import type { OpenRouterChatCompletionRequest } from '@kilocode/llm-shared';
import { createAnthropic } from '@ai-sdk/anthropic';
import type { AnthropicProviderOptions } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import type { OpenAILanguageModelResponsesOptions } from '@ai-sdk/openai';
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
import { createHash } from 'crypto';
import { inArray } from 'drizzle-orm';
import type { WorkerDb } from '../lib/db.js';

// ---------------------------------------------------------------------------
// Reasoning format enum (from custom-llm/format.ts — different from llm-shared ReasoningFormat)
// ---------------------------------------------------------------------------

enum ReasoningFormat {
  Unknown = 'unknown',
  OpenAIResponsesV1 = 'openai-responses-v1',
  XAIResponsesV1 = 'xai-responses-v1',
  AnthropicClaudeV1 = 'anthropic-claude-v1',
  GoogleGeminiV1 = 'google-gemini-v1',
  // hack to prevent the extension from stripping ids
  OpenAIResponsesV1_Obscured = 'openai-responses-v1-obscured',
}

// Local reasoning detail types — broader than @kilocode/llm-shared's ReasoningDetailUnion
// because the format field here includes provider-specific values from the ReasoningFormat enum.
type ReasoningDetailText = {
  type: ReasoningDetailType.Text;
  text?: string | null;
  signature?: string | null;
  id?: string | null;
  format?: string | null;
  index?: number;
};

type ReasoningDetailEncrypted = {
  type: ReasoningDetailType.Encrypted;
  data: string;
  id?: string | null;
  format?: string | null;
  index?: number;
};

type ReasoningDetailSummary = {
  type: ReasoningDetailType.Summary;
  summary: string;
  id?: string | null;
  format?: string | null;
  index?: number;
};

type ReasoningDetailUnion = ReasoningDetailText | ReasoningDetailEncrypted | ReasoningDetailSummary;

// ---------------------------------------------------------------------------
// OpenRouter chat completions input types (inlined)
// ---------------------------------------------------------------------------

type OpenRouterCacheControl = { type: 'ephemeral' };

type OpenRouterChatCompletionsInput = ChatCompletionMessageParam[];

type ChatCompletionMessageParam =
  | ChatCompletionSystemMessageParam
  | ChatCompletionUserMessageParam
  | ChatCompletionAssistantMessageParam
  | ChatCompletionToolMessageParam;

type ChatCompletionSystemMessageParam = {
  role: 'system';
  content: string | ChatCompletionContentPartText[];
};

type ChatCompletionUserMessageParam = {
  role: 'user';
  content: string | ChatCompletionContentPart[];
  cache_control?: OpenRouterCacheControl;
};

type ChatCompletionContentPart =
  | ChatCompletionContentPartText
  | ChatCompletionContentPartImage
  | ChatCompletionContentPartFile
  | ChatCompletionContentPartInputAudio;

type ChatCompletionContentPartText = {
  type: 'text';
  text: string;
  reasoning?: string | null;
  cache_control?: OpenRouterCacheControl;
};

type ChatCompletionContentPartImage = {
  type: 'image_url';
  image_url: { url: string };
  cache_control?: OpenRouterCacheControl;
};

type ChatCompletionContentPartFile = {
  type: 'file';
  file: { filename?: string; file_data?: string; file_id?: string };
  cache_control?: OpenRouterCacheControl;
};

type ChatCompletionContentPartInputAudio = {
  type: 'input_audio';
  input_audio: { data: string; format: string };
  cache_control?: OpenRouterCacheControl;
};

type ChatCompletionAssistantMessageParam = {
  role: 'assistant';
  content?: string | null;
  reasoning?: string | null;
  reasoning_details?: ReasoningDetailUnion[];
  tool_calls?: ChatCompletionMessageToolCall[];
  cache_control?: OpenRouterCacheControl;
};

type ChatCompletionMessageToolCall = {
  type: 'function';
  id: string;
  function: { arguments: string; name: string };
};

type ChatCompletionToolMessageParam = {
  role: 'tool';
  content: string | ChatCompletionContentPart[];
  tool_call_id: string;
  cache_control?: OpenRouterCacheControl;
};

// ---------------------------------------------------------------------------
// Lightweight output chunk types (we produce these, not parse)
// ---------------------------------------------------------------------------

type ChatCompletionChunkChoice = {
  delta: {
    role?: 'assistant';
    content?: string | null;
    reasoning?: string | null;
    reasoning_details?: ReasoningDetailUnion[];
    tool_calls?: {
      index: number;
      id?: string;
      type?: 'function';
      function: { name?: string; arguments?: string };
    }[];
  };
  finish_reason?: string | null;
};

type ChatCompletionChunk = {
  id?: string;
  model: string;
  choices: ChatCompletionChunkChoice[];
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    prompt_tokens_details?: {
      cached_tokens: number;
      cache_write_tokens?: number;
    };
    completion_tokens_details?: {
      reasoning_tokens: number;
    };
  };
};

// ---------------------------------------------------------------------------
// AI SDK reasoning part (mirrors @ai-sdk/provider-utils ReasoningPart)
// ---------------------------------------------------------------------------

type JsonValue = string | number | boolean | null | { [key: string]: JsonValue } | JsonValue[];
type AiSdkProviderOptions = Record<string, Record<string, JsonValue>>;

type AiSdkReasoningPart = {
  type: 'reasoning';
  text: string;
  providerOptions?: AiSdkProviderOptions;
};

// ---------------------------------------------------------------------------
// Reasoning provider metadata helpers (from reasoning-provider-metadata.ts)
// ---------------------------------------------------------------------------

type ProviderMetadata = Record<string, Record<string, unknown>> | undefined;

function extractSignature(meta: ProviderMetadata): string | null {
  if (!meta) return null;
  const anthropicSig = meta.anthropic?.signature;
  if (typeof anthropicSig === 'string') return anthropicSig;
  const googleSig = meta.google?.thoughtSignature;
  if (typeof googleSig === 'string') return googleSig;
  const vertexSig = meta.vertex?.thoughtSignature;
  if (typeof vertexSig === 'string') return vertexSig;
  return null;
}

function extractEncryptedData(meta: ProviderMetadata): string | null {
  if (!meta) return null;
  const anthropic = meta.anthropic?.redactedData;
  if (typeof anthropic === 'string') return anthropic;
  const openai = meta.openai?.reasoningEncryptedContent;
  if (typeof openai === 'string') return openai;
  const xai = meta.xai?.reasoningEncryptedContent;
  if (typeof xai === 'string') return xai;
  return null;
}

function extractItemId(meta: ProviderMetadata): string | null {
  if (!meta) return null;
  const openaiId = meta.openai?.itemId;
  if (typeof openaiId === 'string') return openaiId;
  const xaiId = meta.xai?.itemId;
  if (typeof xaiId === 'string') return xaiId;
  return null;
}

function extractFormat(meta: ProviderMetadata): ReasoningFormat | null {
  if (!meta) return null;
  if (meta.anthropic) return ReasoningFormat.AnthropicClaudeV1;
  if (meta.openai) return ReasoningFormat.OpenAIResponsesV1;
  if (meta.xai) return ReasoningFormat.XAIResponsesV1;
  if (meta.google || meta.vertex) return ReasoningFormat.GoogleGeminiV1;
  return null;
}

const FORMAT_TO_PROVIDER_KEY: Partial<Record<ReasoningFormat, string>> = {
  [ReasoningFormat.AnthropicClaudeV1]: 'anthropic',
  [ReasoningFormat.OpenAIResponsesV1]: 'openai',
  [ReasoningFormat.XAIResponsesV1]: 'xai',
  [ReasoningFormat.GoogleGeminiV1]: 'google',
};

function detailToAiSdkPart(detail: ReasoningDetailUnion): AiSdkReasoningPart | null {
  switch (detail.type) {
    case ReasoningDetailType.Text: {
      const text = (detail as ReasoningDetailText).text ?? '';
      const opts = buildTextProviderOptions(detail as ReasoningDetailText);
      return { type: 'reasoning', text, ...(opts ? { providerOptions: opts } : {}) };
    }
    case ReasoningDetailType.Encrypted: {
      const opts = buildEncryptedProviderOptions(detail as ReasoningDetailEncrypted);
      return { type: 'reasoning', text: '', ...(opts ? { providerOptions: opts } : {}) };
    }
    case ReasoningDetailType.Summary:
      return { type: 'reasoning', text: (detail as { summary: string }).summary };
  }
}

function buildTextProviderOptions(detail: ReasoningDetailText): AiSdkProviderOptions | null {
  const format = (detail as Record<string, unknown>).format as ReasoningFormat | undefined;
  switch (format) {
    case ReasoningFormat.AnthropicClaudeV1: {
      if (!detail.signature) return null;
      return { anthropic: { signature: detail.signature } };
    }
    case ReasoningFormat.OpenAIResponsesV1: {
      if (!detail.id) return null;
      return { openai: { itemId: detail.id } };
    }
    case ReasoningFormat.XAIResponsesV1: {
      if (!detail.id) return null;
      return { xai: { itemId: detail.id } };
    }
    case ReasoningFormat.GoogleGeminiV1: {
      if (!detail.signature) return null;
      return { google: { thoughtSignature: detail.signature } };
    }
    default:
      return null;
  }
}

function buildEncryptedProviderOptions(
  detail: ReasoningDetailEncrypted
): AiSdkProviderOptions | null {
  const format = (detail as Record<string, unknown>).format as ReasoningFormat | undefined;
  switch (format) {
    case ReasoningFormat.AnthropicClaudeV1:
      return { anthropic: { redactedData: detail.data } };
    case ReasoningFormat.OpenAIResponsesV1: {
      const inner: Record<string, JsonValue> = { reasoningEncryptedContent: detail.data };
      if (detail.id) inner.itemId = detail.id;
      return { openai: inner };
    }
    case ReasoningFormat.XAIResponsesV1: {
      const inner: Record<string, JsonValue> = { reasoningEncryptedContent: detail.data };
      if (detail.id) inner.itemId = detail.id;
      return { xai: inner };
    }
    default:
      return null;
  }
}

function mergeEncryptedIntoTextParts(details: ReasoningDetailUnion[]): AiSdkReasoningPart[] {
  const encryptedById = new Map<string, string>();
  for (const d of details) {
    if (d.type === ReasoningDetailType.Encrypted && d.id) {
      encryptedById.set(d.id, (d as ReasoningDetailEncrypted).data);
    }
  }

  const usedEncryptedIds = new Set<string>();
  const parts: AiSdkReasoningPart[] = [];

  for (const detail of details) {
    if (detail.type === ReasoningDetailType.Encrypted) continue;

    const part = detailToAiSdkPart(detail);
    if (!part) continue;

    if (detail.type === ReasoningDetailType.Text && detail.id) {
      const encryptedData = encryptedById.get(detail.id);
      if (encryptedData) {
        const format = (detail as Record<string, unknown>).format as ReasoningFormat | undefined;
        const providerKey = format ? FORMAT_TO_PROVIDER_KEY[format] : undefined;
        if (providerKey) {
          const existing = (part.providerOptions?.[providerKey] ?? {}) as Record<string, JsonValue>;
          part.providerOptions = {
            ...part.providerOptions,
            [providerKey]: { ...existing, reasoningEncryptedContent: encryptedData },
          };
          usedEncryptedIds.add(detail.id);
        }
      }
    }

    parts.push(part);
  }

  for (const detail of details) {
    if (detail.type !== ReasoningDetailType.Encrypted) continue;
    if (detail.id && usedEncryptedIds.has(detail.id)) continue;
    const part = detailToAiSdkPart(detail);
    if (part) parts.push(part);
  }

  return parts;
}

function reasoningDetailsToAiSdkParts(details: ReasoningDetailUnion[]): AiSdkReasoningPart[] {
  const needsMerge = details.some(d => {
    const format = (d as Record<string, unknown>).format as string | undefined;
    return (
      format === ReasoningFormat.OpenAIResponsesV1 || format === ReasoningFormat.XAIResponsesV1
    );
  });

  if (needsMerge) return mergeEncryptedIntoTextParts(details);

  const parts: AiSdkReasoningPart[] = [];
  for (const detail of details) {
    const part = detailToAiSdkPart(detail);
    if (part) parts.push(part);
  }
  return parts;
}

function reasoningOutputToDetails(
  reasoning: ReadonlyArray<{ type: 'reasoning'; text: string; providerMetadata?: ProviderMetadata }>
): ReasoningDetailUnion[] {
  const details: ReasoningDetailUnion[] = [];

  for (const part of reasoning) {
    const signature = extractSignature(part.providerMetadata);
    const encryptedData = extractEncryptedData(part.providerMetadata);
    const itemId = extractItemId(part.providerMetadata);
    const format = extractFormat(part.providerMetadata);
    const optionalFields = {
      ...(itemId ? { id: itemId } : {}),
      ...(format ? { format } : {}),
    };

    if (part.text) {
      details.push({
        type: ReasoningDetailType.Text,
        text: part.text,
        ...(signature ? { signature } : {}),
        ...optionalFields,
      });
    }

    if (encryptedData) {
      details.push({
        type: ReasoningDetailType.Encrypted,
        data: encryptedData,
        ...optionalFields,
      });
    }
  }

  return details;
}

// ---------------------------------------------------------------------------
// Message conversion
// ---------------------------------------------------------------------------

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

function convertToolOutput(content: string | ChatCompletionContentPart[]) {
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

// ---------------------------------------------------------------------------
// Tool conversion
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Finish reason mapping
// ---------------------------------------------------------------------------

const FINISH_REASON_MAP: Record<string, string> = {
  stop: 'stop',
  length: 'length',
  'content-filter': 'content_filter',
  'tool-calls': 'tool_calls',
  error: 'error',
  other: 'stop',
};

// ---------------------------------------------------------------------------
// Phase key (for OpenAI phase param patching)
// ---------------------------------------------------------------------------

function phaseKey(userId: string, taskId: string | undefined, content: string[]) {
  return createHash('sha256')
    .update([userId, taskId, ...content].join('|'))
    .digest('hex');
}

function extractMessageTextParts(content: unknown): string[] {
  if (typeof content === 'string') return [content];
  if (!Array.isArray(content)) return [];
  return content
    .filter(
      (part): part is { type: string; text: string } =>
        part !== null &&
        typeof part === 'object' &&
        (part.type === 'input_text' || part.type === 'output_text') &&
        typeof part.text === 'string'
    )
    .map(part => part.text);
}

// ---------------------------------------------------------------------------
// Stream part → SSE chunk converter
// ---------------------------------------------------------------------------

function createStreamPartConverter(
  userId: string,
  taskId: string | undefined,
  model: string,
  db: WorkerDb
) {
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
      case 'raw': {
        // Minimal type for the response stream event we care about
        const event = part.rawValue as {
          type: string;
          item: {
            type: string;
            phase?: string;
            content: { type: string; text: string }[];
          };
        };
        if (event.type === 'response.output_item.done') {
          const item = event.item;
          const phase = typeof item.phase === 'string' ? item.phase : null;
          if (item.type === 'message' && phase) {
            await db
              .insert(temp_phase)
              .values({
                key: phaseKey(
                  userId,
                  taskId,
                  item.content.filter(c => c.type === 'output_text').map(c => c.text)
                ),
                value: phase,
              })
              .onConflictDoNothing();
          }
        }
        return null;
      }

      case 'text-delta':
        return {
          ...(id !== undefined ? { id } : {}),
          model,
          choices: [{ delta: { content: part.text } }],
        };

      case 'reasoning-start': {
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

// ---------------------------------------------------------------------------
// Non-streaming result converter
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Common params builder
// ---------------------------------------------------------------------------

function buildCommonParams(
  customLlm: CustomLlm,
  messages: ModelMessage[],
  request: OpenRouterChatCompletionRequest,
  isLegacyExtension: boolean
) {
  // Access extension-specific fields via loose typing
  const req = request as unknown as Record<string, unknown>;
  const verbosity = VerbositySchema.safeParse(
    (req.verbosity as string) ?? customLlm.verbosity
  ).data;
  const reasoningConfig = request.reasoning as { effort?: string } | undefined;
  const reasoningEffort = ReasoningEffortSchema.safeParse(
    reasoningConfig?.effort ?? customLlm.reasoning_effort
  ).data;
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
        promptCacheKey: req.prompt_cache_key as string | undefined,
        safetyIdentifier: req.safety_identifier as string | undefined,
        user: request.user,
      } satisfies OpenAILanguageModelResponsesOptions,
    },
  };
}

// ---------------------------------------------------------------------------
// Model creation
// ---------------------------------------------------------------------------

function createModel(
  customLlm: CustomLlm,
  userId: string,
  taskId: string | undefined,
  db: WorkerDb
) {
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
      fetch:
        customLlm.base_url === 'https://api.openai.com/v1'
          ? responseCreateParamsPatchFetch(userId, taskId, db)
          : undefined,
    });
    return openai(customLlm.internal_id);
  }
  throw new Error(`Unknown provider: ${customLlm.provider}`);
}

// ---------------------------------------------------------------------------
// OpenAI phase param patching fetch wrapper
// ---------------------------------------------------------------------------

function responseCreateParamsPatchFetch(userId: string, taskId: string | undefined, db: WorkerDb) {
  return async function (input: string | URL | Request, init?: RequestInit) {
    if (typeof init?.body === 'string') {
      const json = JSON.parse(init.body) as {
        input?: Array<{ role?: string; content?: unknown; phase?: string }>;
      };
      if (Array.isArray(json.input)) {
        type AssistantMessage = { role: 'assistant'; content?: unknown; phase?: string };
        const assistantMessages = json.input.filter(
          (message): message is AssistantMessage =>
            'role' in message && message.role === 'assistant'
        );

        if (assistantMessages.length > 0) {
          const keyByMessage = new Map(
            assistantMessages.map(message => [
              message,
              phaseKey(userId, taskId, extractMessageTextParts(message.content)),
            ])
          );

          const keys = [...new Set(keyByMessage.values())];
          const rows = await db
            .select({ key: temp_phase.key, phase: temp_phase.value })
            .from(temp_phase)
            .where(inArray(temp_phase.key, keys));
          const phaseByKey = new Map(rows.map(row => [row.key, row.phase]));

          for (const message of assistantMessages) {
            const phase = phaseByKey.get(keyByMessage.get(message) ?? '');
            if (phase) {
              Object.assign(message, { phase });
            } else {
              console.error(
                `[responseCreateParamsPatchFetch] failed to find phase param for userId: ${userId}, taskId: ${taskId}`
              );
            }
          }

          init.body = JSON.stringify(json);
        }
      }
    }
    return await fetch(input, init);
  };
}

// ---------------------------------------------------------------------------
// Legacy extension hacks (reasoning format obscuring)
// ---------------------------------------------------------------------------

function reverseLegacyExtensionHack(messages: OpenRouterChatCompletionsInput) {
  for (const msg of messages) {
    if (msg.role === 'assistant') {
      for (const rd of msg.reasoning_details ?? []) {
        const record = rd as Record<string, unknown>;
        if (record.format === ReasoningFormat.OpenAIResponsesV1_Obscured) {
          record.format = ReasoningFormat.OpenAIResponsesV1;
        }
      }
    }
  }
}

function applyLegacyExtensionHack(choice: ChatCompletionChunkChoice | undefined) {
  for (const rd of choice?.delta?.reasoning_details ?? []) {
    const record = rd as Record<string, unknown>;
    if (record.format === ReasoningFormat.OpenAIResponsesV1) {
      record.format = ReasoningFormat.OpenAIResponsesV1_Obscured;
    }
  }
}

// ---------------------------------------------------------------------------
// Error response helper
// ---------------------------------------------------------------------------

function errorResponse(status: number, message: string) {
  return Response.json({ error: { message, code: status, type: 'error' } }, { status });
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function customLlmRequest(
  customLlm: CustomLlm,
  request: OpenRouterChatCompletionRequest,
  userId: string,
  taskId: string | undefined,
  isLegacyExtension: boolean,
  db: WorkerDb
): Promise<Response> {
  const messages = request.messages as unknown as OpenRouterChatCompletionsInput;
  if (isLegacyExtension) {
    reverseLegacyExtensionHack(messages);
  }

  const model = createModel(customLlm, userId, taskId, db);
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
      return Response.json(convertedResponse);
    } catch (e) {
      console.error('Caught exception while processing non-streaming request', e);
      const status = APICallError.isInstance(e) ? (e.statusCode ?? 500) : 500;
      const msg = e instanceof Error ? e.message : 'Generation failed';
      return errorResponse(status, msg);
    }
  }

  const result = streamText({ model, ...commonParams, includeRawChunks: true });

  const convertStreamPartToChunk = createStreamPartConverter(userId, taskId, modelId, db);

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      try {
        for await (const chunk of result.fullStream) {
          const converted = await convertStreamPartToChunk(chunk);
          if (converted) {
            if (isLegacyExtension) {
              applyLegacyExtensionHack(converted.choices[0]);
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
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream',
    },
  });
}
