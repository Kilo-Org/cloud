import type { EventSourceMessage } from 'eventsource-parser';
import { captureMessage, startInactiveSpan } from '@sentry/nextjs';
import type { Span } from '@sentry/nextjs';
import { z } from 'zod';
import { sentryRootSpan } from '../getRootSpan';
import type { ProviderType } from '@kilocode/web-shared/lib/ai-gateway/providers/types';
import type {
  JustTheCostsUsageStats,
  MicrodollarUsageStats,
  NotYetCostedUsageStats,
  PromptInfo,
  VercelProviderMetaData,
} from '@kilocode/web-shared/lib/ai-gateway/processUsage.types';
import type { GatewayMessagesRequest } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/types';
import {
  drainSseStream,
  extractVercelUpstreamId,
  reportUpstreamStreamError,
  selectUsageCostFields,
  upstreamStreamErrorSchema,
  usageCostSchema,
  vercelProviderMetadataSchema,
} from '@kilocode/web-shared/lib/ai-gateway/processUsage.shared';
import { isErrorFinishReason } from '@kilocode/web-shared/lib/ai-gateway/finishReason';
import type { AiProviderMetadataCapture } from '@kilocode/web-shared/lib/r2/kilo-routing-decision';

const messagesUsageSchema = usageCostSchema.extend({
  input_tokens: z.number().nullish(),
  output_tokens: z.number().nullish(),
  cache_creation_input_tokens: z.number().nullish(),
  cache_read_input_tokens: z.number().nullish(),
});

type MessagesApiUsage = z.infer<typeof messagesUsageSchema>;

const messageSchema = z.object({
  id: z.string().nullish(),
  model: z.string(),
  usage: messagesUsageSchema.nullish(),
  provider_metadata: vercelProviderMetadataSchema.nullish(),
  provider: z.string().nullish(),
});

const messageEventSchema = z
  .object({
    type: z.string(),
    error: upstreamStreamErrorSchema.nullish(),
  })
  .passthrough();

const contentDeltaSchema = z
  .object({ type: z.string(), text: z.string().optional() })
  .refine(delta => delta.type !== 'text_delta' || delta.text !== undefined);

const messageDeltaSchema = z.object({
  delta: z.object({ stop_reason: z.string().nullish() }).nullish(),
  usage: messagesUsageSchema.nullish(),
  provider_metadata: vercelProviderMetadataSchema.nullish(),
});

const messageResponseSchema = messageSchema.extend({
  stop_reason: z.string().nullish(),
  content: z
    .array(
      z
        .object({ type: z.string(), text: z.string().optional() })
        .refine(block => block.type !== 'text' || block.text !== undefined)
        .nullable()
    )
    .nullish(),
});

// message_start already reports the input and cache tokens, so a stream that
// stops before message_delta still records the prompt it consumed. Providers
// that repeat these fields in message_delta, or send them as null, keep the
// message_delta value only when it is present.
function mergeMessageDeltaUsage(
  startUsage: MessagesApiUsage | null,
  deltaUsage: MessagesApiUsage
): MessagesApiUsage {
  if (!startUsage) return deltaUsage;
  return {
    ...deltaUsage,
    input_tokens: deltaUsage.input_tokens ?? startUsage.input_tokens,
    cache_creation_input_tokens:
      deltaUsage.cache_creation_input_tokens ?? startUsage.cache_creation_input_tokens,
    cache_read_input_tokens:
      deltaUsage.cache_read_input_tokens ?? startUsage.cache_read_input_tokens,
  };
}

function getVercelResolvedModel(
  providerMetadata: VercelProviderMetaData | null | undefined
): string | undefined {
  const routing = providerMetadata?.gateway?.routing;
  return (
    routing?.modelAttempts?.find(attempt => attempt.success)?.canonicalSlug ??
    routing?.canonicalSlug
  );
}

export function processMessagesApiUsage(
  usage: MessagesApiUsage | null | undefined,
  providerMetadata: VercelProviderMetaData | null | undefined,
  coreProps: NotYetCostedUsageStats,
  provider: ProviderType
): JustTheCostsUsageStats {
  const cacheHitTokens = usage?.cache_read_input_tokens ?? 0;
  const cacheWriteTokens = usage?.cache_creation_input_tokens ?? 0;
  const inputTokens = (usage?.input_tokens ?? 0) + cacheHitTokens + cacheWriteTokens;
  const outputTokens = usage?.output_tokens ?? 0;

  const costs = selectUsageCostFields(
    usage,
    providerMetadata,
    coreProps,
    'messages_sse_processing',
    provider
  );
  return { inputTokens, outputTokens, cacheHitTokens, cacheWriteTokens, ...costs };
}

export async function parseMessagesMicrodollarUsageFromStream(
  stream: ReadableStream<Uint8Array>,
  kiloUserId: string,
  openrouterRequestSpan: Span | undefined,
  provider: ProviderType,
  statusCode: number,
  usesUserCredentials: boolean,
  requestStartedAt?: number,
  metadataCapture?: AiProviderMetadataCapture
): Promise<MicrodollarUsageStats> {
  openrouterRequestSpan?.end();
  const streamProcessingSpan = startInactiveSpan({
    name: 'messages-stream-processing',
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
  const startedAt = performance.now();
  let firstTokenReceived = false;
  let startUsage: MessagesApiUsage | null = null;
  let deltaUsage: MessagesApiUsage | null = null;
  let finish_reason: string | null = null;
  let providerMetadata: VercelProviderMetaData | null = null;
  let inference_provider: string | null = null;

  const onEvent = (event: EventSourceMessage) => {
    if (!firstTokenReceived) {
      sentryRootSpan()?.setAttribute(
        'messages.time_to_first_token_ms',
        performance.now() - startedAt
      );
      firstTokenReceived = true;
      timeToFirstTokenSpan.end();
    }

    if (event.data === '[DONE]') {
      metadataCapture?.captureVercelMetadata('[DONE]');
      return;
    }

    const payload: unknown = JSON.parse(event.data);
    const json = messageEventSchema.parse(payload);
    metadataCapture?.captureVercelMetadata(payload);

    if (json.type === 'error' && json.error != null) {
      reportedError = true;
      finish_reason = json.error.error_type ?? json.error.type ?? 'error';
      reportUpstreamStreamError({
        label: 'Messages API stream error',
        source: 'messages_sse_processing',
        error: json.error,
        usesUserCredentials,
        logContext: { provider, inference_provider, messageId, model },
        sentryExtra: { json: payload, event },
      });
      return;
    }

    let eventProviderMetadata: VercelProviderMetaData | null | undefined;
    if (json.type === 'message_start') {
      const message = messageSchema.parse(json.message);
      messageId = message.id ?? messageId;
      model = message.model;
      startUsage = message.usage ?? startUsage;
      eventProviderMetadata = message.provider_metadata;
      if (message.provider) {
        inference_provider = message.provider;
      }
    }

    if (json.type === 'content_block_delta') {
      const delta = contentDeltaSchema.parse(json.delta);
      if (delta.type === 'text_delta' && delta.text) {
        responseContent += delta.text;
      }
    }

    if (json.type === 'message_delta') {
      const delta = messageDeltaSchema.parse(json);
      finish_reason = delta.delta?.stop_reason ?? finish_reason;
      deltaUsage = delta.usage ?? deltaUsage;
      eventProviderMetadata = delta.provider_metadata;
    }

    if (eventProviderMetadata) {
      providerMetadata = eventProviderMetadata;
      model = getVercelResolvedModel(eventProviderMetadata) ?? model;
      inference_provider =
        eventProviderMetadata.gateway?.routing?.finalProvider ?? inference_provider;
    }
  };

  const { wasAborted, malformedEventCount, timing } = await drainSseStream(
    stream,
    onEvent,
    streamProcessingSpan,
    requestStartedAt,
    () => ({ kiloUserId, provider, messageId, model })
  );

  if (!reportedError && !deltaUsage) {
    captureMessage('SUSPICIOUS: No usage in Messages API stream', {
      level: 'warning',
      tags: { source: 'messages_usage_processing' },
      extra: { kiloUserId, provider, messageId, model },
    });
  }

  const coreProps = {
    messageId,
    hasError:
      reportedError || wasAborted || malformedEventCount > 0 || isErrorFinishReason(finish_reason),
    model,
    responseContent,
    inference_provider,
    finish_reason,
    upstream_id: extractVercelUpstreamId(providerMetadata),
    latency: timing.latency,
    moderation_latency: null,
    generation_time: timing.generation_time,
    streamed: true,
    cancelled: null,
    status_code: statusCode,
  } satisfies NotYetCostedUsageStats;

  const usage = deltaUsage ? mergeMessageDeltaUsage(startUsage, deltaUsage) : startUsage;
  const costs = processMessagesApiUsage(usage, providerMetadata, coreProps, provider);
  return { ...coreProps, ...costs };
}

export function parseMessagesMicrodollarUsageFromString(
  fullResponse: string,
  statusCode: number,
  provider: ProviderType,
  metadataCapture?: AiProviderMetadataCapture
): MicrodollarUsageStats {
  const payload: unknown = JSON.parse(fullResponse);
  const responseJson = messageResponseSchema.parse(payload);
  const usage = responseJson.usage;
  const providerMetadata = responseJson.provider_metadata ?? null;
  metadataCapture?.captureVercelMetadata(payload);
  const inference_provider =
    providerMetadata?.gateway?.routing?.finalProvider ?? responseJson.provider ?? null;

  const responseContent = (responseJson.content ?? [])
    .filter(c => c?.type === 'text')
    .map(c => c?.text)
    .join('');

  const finish_reason = responseJson.stop_reason ?? null;
  const coreProps = {
    messageId: responseJson.id ?? null,
    hasError: !responseJson.model || statusCode >= 400 || isErrorFinishReason(finish_reason),
    model: getVercelResolvedModel(providerMetadata) ?? responseJson.model,
    responseContent,
    inference_provider,
    upstream_id: extractVercelUpstreamId(providerMetadata),
    finish_reason,
    latency: null,
    moderation_latency: null,
    generation_time: null,
    streamed: false,
    cancelled: null,
    status_code: statusCode,
  } satisfies NotYetCostedUsageStats;

  const costs = processMessagesApiUsage(usage, providerMetadata, coreProps, provider);
  return { ...coreProps, ...costs };
}

export function extractMessagesPromptInfo(body: GatewayMessagesRequest): PromptInfo {
  const systemContent =
    typeof body.system === 'string'
      ? body.system
      : Array.isArray(body.system)
        ? body.system.map(b => b.text).join('\n')
        : '';

  const lastUserMessage = body.messages.filter(m => m.role === 'user').at(-1);

  let userPrompt = '';
  if (lastUserMessage) {
    const content = lastUserMessage.content;
    if (typeof content === 'string') {
      userPrompt = content;
    } else {
      userPrompt = content
        .filter((c): c is { type: 'text'; text: string } => c != null && c.type === 'text')
        .map(c => c.text)
        .join('\n');
    }
  }

  return {
    system_prompt_prefix: systemContent.slice(0, 100),
    system_prompt_length: systemContent.length,
    user_prompt_prefix: userPrompt.slice(0, 100),
  };
}
