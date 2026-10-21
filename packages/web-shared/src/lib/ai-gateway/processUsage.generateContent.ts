import { createParser, type EventSourceMessage } from 'eventsource-parser';
import { captureException, captureMessage, startInactiveSpan } from '@sentry/nextjs';
import type { Span } from '@sentry/nextjs';
import { sentryRootSpan } from '../getRootSpan';
import type { ProviderId } from '@kilocode/web-shared/lib/ai-gateway/providers/types';
import type {
  JustTheCostsUsageStats,
  MicrodollarUsageStats,
  NotYetCostedUsageStats,
  PromptInfo,
} from '@kilocode/web-shared/lib/ai-gateway/processUsage.types';
import type {
  GatewayGenerateContentRequest,
  GeminiContent,
  GeminiPart,
} from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/types';
import { drainSseStream } from '@kilocode/web-shared/lib/ai-gateway/processUsage.shared';
import { isErrorFinishReason } from '@kilocode/web-shared/lib/ai-gateway/finishReason';

// https://ai.google.dev/api/generate-content#UsageMetadata
export type GeminiUsageMetadata = {
  promptTokenCount?: number;
  cachedContentTokenCount?: number;
  candidatesTokenCount?: number;
  toolUsePromptTokenCount?: number;
  thoughtsTokenCount?: number;
  totalTokenCount?: number;
};

// https://ai.google.dev/api/generate-content#v1beta.GenerateContentResponse
export type GenerateContentResponse = {
  responseId?: string;
  modelVersion?: string;
  candidates?: { content?: { parts?: GeminiPart[] }; finishReason?: string }[];
  promptFeedback?: { blockReason?: string };
  usageMetadata?: GeminiUsageMetadata;
  error?: { code?: number; message?: string; status?: string };
};

// https://ai.google.dev/api/generate-content#FinishReason
const GEMINI_ERROR_FINISH_REASONS: ReadonlySet<string> = new Set([
  'safety',
  'recitation',
  'language',
  'blocklist',
  'prohibited_content',
  'spii',
  'malformed_function_call',
  'image_safety',
  'unexpected_tool_call',
  'too_many_tool_calls',
]);

function isGeminiErrorFinishReason(finishReason: string | null) {
  return (
    finishReason !== null &&
    (isErrorFinishReason(finishReason) || GEMINI_ERROR_FINISH_REASONS.has(finishReason))
  );
}

/**
 * Gemini's promptTokenCount already includes the cached tokens, and
 * candidatesTokenCount excludes the thinking tokens, which are billed as output.
 */
export function processGenerateContentUsage(
  usage: GeminiUsageMetadata | null | undefined
): JustTheCostsUsageStats {
  return {
    inputTokens: (usage?.promptTokenCount ?? 0) + (usage?.toolUsePromptTokenCount ?? 0),
    cacheHitTokens: usage?.cachedContentTokenCount ?? 0,
    cacheWriteTokens: 0,
    outputTokens: (usage?.candidatesTokenCount ?? 0) + (usage?.thoughtsTokenCount ?? 0),
    cost_mUsd: 0,
    is_byok: null,
  };
}

function partsText(parts: ReadonlyArray<GeminiPart | null> | undefined) {
  return (Array.isArray(parts) ? parts : [])
    .map(part => (part && !part.thought && typeof part.text === 'string' ? part.text : ''))
    .join('');
}

function firstCandidate(response: GenerateContentResponse) {
  return response.candidates?.[0];
}

function finishReasonOf(response: GenerateContentResponse) {
  const finishReason =
    firstCandidate(response)?.finishReason ?? response.promptFeedback?.blockReason;
  return finishReason ? finishReason.toLowerCase() : null;
}

export async function parseGenerateContentMicrodollarUsageFromStream(
  stream: ReadableStream,
  kiloUserId: string,
  openrouterRequestSpan: Span | undefined,
  provider: ProviderId,
  statusCode: number
): Promise<MicrodollarUsageStats> {
  openrouterRequestSpan?.end();
  const streamProcessingSpan = startInactiveSpan({
    name: 'generate-content-stream-processing',
    op: 'performance',
  });
  const timeToFirstTokenSpan = startInactiveSpan({
    name: 'time-to-first-token',
    op: 'performance',
  });

  let messageId: string | null = null;
  let model: string | null = null;
  let responseContent = '';
  let reportedError = statusCode >= 400;
  let effectiveStatusCode = statusCode;
  const startedAt = performance.now();
  let firstTokenReceived = false;
  let usage: GeminiUsageMetadata | null = null;
  let finish_reason: string | null = null;

  const sseStreamParser = createParser({
    onEvent(event: EventSourceMessage) {
      if (!firstTokenReceived) {
        sentryRootSpan()?.setAttribute(
          'generate_content.time_to_first_token_ms',
          performance.now() - startedAt
        );
        firstTokenReceived = true;
        timeToFirstTokenSpan.end();
      }

      if (event.data === '[DONE]') {
        return;
      }

      const json = JSON.parse(event.data) as GenerateContentResponse | null;
      if (!json) {
        captureException(new Error('SUSPICIOUS: No JSON in SSE event'), {
          extra: { event },
        });
        return;
      }

      if (json.error) {
        reportedError = true;
        if (typeof json.error.code === 'number') {
          effectiveStatusCode = json.error.code;
        }
        captureException(new Error(`Gemini API stream error: ${json.error.message ?? 'unknown'}`), {
          tags: { source: 'generate_content_sse_processing' },
          extra: { json, event },
        });
        return;
      }

      messageId = json.responseId ?? messageId;
      model = json.modelVersion ?? model;
      usage = json.usageMetadata ?? usage;
      finish_reason = finishReasonOf(json) ?? finish_reason;
      responseContent += partsText(firstCandidate(json)?.content?.parts);
    },
  });

  const wasAborted = await drainSseStream(
    stream,
    chunk => sseStreamParser.feed(chunk),
    streamProcessingSpan
  );

  if (!reportedError && !usage) {
    captureMessage('SUSPICIOUS: No usage in Gemini API stream', {
      level: 'warning',
      tags: { source: 'generate_content_usage_processing' },
      extra: { kiloUserId, provider, messageId, model },
    });
  }

  const coreProps = {
    messageId,
    hasError: reportedError || wasAborted || isGeminiErrorFinishReason(finish_reason),
    model,
    responseContent,
    inference_provider: null,
    finish_reason,
    upstream_id: null,
    latency: null,
    moderation_latency: null,
    generation_time: null,
    streamed: true,
    cancelled: null,
    status_code: effectiveStatusCode,
  } satisfies NotYetCostedUsageStats;

  return { ...coreProps, ...processGenerateContentUsage(usage) };
}

export function parseGenerateContentMicrodollarUsageFromString(
  fullResponse: string,
  statusCode: number
): MicrodollarUsageStats {
  const responseJson = JSON.parse(fullResponse) as GenerateContentResponse | null;
  const finish_reason = responseJson ? finishReasonOf(responseJson) : null;

  const coreProps = {
    messageId: responseJson?.responseId ?? null,
    hasError:
      !responseJson ||
      !!responseJson.error ||
      statusCode >= 400 ||
      isGeminiErrorFinishReason(finish_reason),
    model: responseJson?.modelVersion ?? null,
    responseContent: responseJson ? partsText(firstCandidate(responseJson)?.content?.parts) : '',
    inference_provider: null,
    upstream_id: null,
    finish_reason,
    latency: null,
    moderation_latency: null,
    generation_time: null,
    streamed: false,
    cancelled: null,
    status_code: statusCode,
  } satisfies NotYetCostedUsageStats;

  return { ...coreProps, ...processGenerateContentUsage(responseJson?.usageMetadata) };
}

export function lastGeminiUserText(contents: ReadonlyArray<GeminiContent | null>) {
  const lastUserContent = contents.findLast(
    content =>
      content?.role === 'user' &&
      Array.isArray(content.parts) &&
      content.parts.some(part => part && !part.functionResponse)
  );
  return lastUserContent ? partsText(lastUserContent.parts) : null;
}

export function extractGenerateContentPromptInfo(body: GatewayGenerateContentRequest): PromptInfo {
  const systemPrompt = partsText(body.systemInstruction?.parts);
  const userPrompt = lastGeminiUserText(body.contents) ?? '';
  return {
    system_prompt_prefix: systemPrompt.slice(0, 100),
    system_prompt_length: systemPrompt.length,
    user_prompt_prefix: userPrompt.slice(0, 100),
  };
}
