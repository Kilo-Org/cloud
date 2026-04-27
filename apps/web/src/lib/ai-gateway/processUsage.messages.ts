import { createParser, type EventSourceMessage } from 'eventsource-parser';
import { captureException, captureMessage, startInactiveSpan } from '@sentry/nextjs';
import type { Span } from '@sentry/nextjs';
import { sentryRootSpan } from '../getRootSpan';
import type { ProviderId } from '@/lib/ai-gateway/providers/types';
import type {
  JustTheCostsUsageStats,
  MicrodollarUsageStats,
  NotYetCostedUsageStats,
  PromptInfo,
  VercelProviderMetaData,
} from '@/lib/ai-gateway/processUsage.types';
import type { GatewayMessagesRequest } from '@/lib/ai-gateway/providers/openrouter/types';
import {
  computeOpenRouterCostFields,
  computeVercelCostMicrodollars,
  drainSseStream,
} from '@/lib/ai-gateway/processUsage.shared';
import type Anthropic from '@anthropic-ai/sdk';

type MaybeHasVercelProviderMetadata = {
  provider_metadata?: VercelProviderMetaData;
};

// Anthropic usage combined with OpenRouter cost fields
// ref: https://docs.anthropic.com/en/api/messages
// ref: https://openrouter.ai/docs/use-cases/usage-accounting#response-format
type MessagesApiUsage = Anthropic.Messages.MessageDeltaUsage & {
  cost?: number;
  is_byok?: boolean | null;
  cost_details?: { upstream_inference_cost: number };
};

export function processMessagesApiUsage(
  usage: MessagesApiUsage | null | undefined,
  providerMetadata: VercelProviderMetaData | null | undefined,
  coreProps: NotYetCostedUsageStats
): JustTheCostsUsageStats {
  const cacheHitTokens = usage?.cache_read_input_tokens ?? 0;
  const cacheWriteTokens = usage?.cache_creation_input_tokens ?? 0;
  const inputTokens = (usage?.input_tokens ?? 0) + cacheHitTokens + cacheWriteTokens;
  const outputTokens = usage?.output_tokens ?? 0;

  // OpenRouter path: cost fields are present directly in usage
  if (usage?.cost != null || usage?.is_byok != null) {
    const { cost_mUsd, is_byok } = computeOpenRouterCostFields(
      usage,
      coreProps,
      'messages_sse_processing'
    );
    return { inputTokens, outputTokens, cacheHitTokens, cacheWriteTokens, cost_mUsd, is_byok };
  }

  // Vercel path: cost is in provider_metadata.gateway
  const vercelGateway = providerMetadata?.gateway;
  if (vercelGateway?.marketCost != null || vercelGateway?.cost != null) {
    const cost_mUsd = computeVercelCostMicrodollars(vercelGateway);
    return {
      inputTokens,
      outputTokens,
      cacheHitTokens,
      cacheWriteTokens,
      cost_mUsd,
      is_byok: null,
    };
  }

  // No cost info available
  return {
    inputTokens,
    outputTokens,
    cacheHitTokens,
    cacheWriteTokens,
    cost_mUsd: 0,
    is_byok: null,
  };
}

export async function parseMessagesMicrodollarUsageFromStream(
  stream: ReadableStream,
  kiloUserId: string,
  openrouterRequestSpan: Span | undefined,
  provider: ProviderId,
  statusCode: number
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
  const reportedError = statusCode >= 400;
  const startedAt = performance.now();
  let firstTokenReceived = false;
  let usage: MessagesApiUsage | null = null;
  let finish_reason: string | null = null;
  let providerMetadata: VercelProviderMetaData | null = null;
  let inference_provider: string | null = null;

  const sseStreamParser = createParser({
    onEvent(event: EventSourceMessage) {
      if (!firstTokenReceived) {
        sentryRootSpan()?.setAttribute(
          'messages.time_to_first_token_ms',
          performance.now() - startedAt
        );
        firstTokenReceived = true;
        timeToFirstTokenSpan.end();
      }

      if (event.data === '[DONE]') {
        return;
      }

      const json = JSON.parse(event.data) as Anthropic.Messages.MessageStreamEvent;

      if (!json) {
        captureException(new Error('SUSPICIOUS: No JSON in SSE event'), {
          extra: { event },
        });
        return;
      }

      if (json.type === 'message_start') {
        messageId = json.message.id;
        model = json.message.model;
      }

      if (
        json.type === 'content_block_delta' &&
        json.delta.type === 'text_delta' &&
        json.delta.text
      ) {
        responseContent += json.delta.text;
      }

      if (json.type === 'message_delta') {
        finish_reason = json.delta.stop_reason;
        usage = json.usage ?? usage;
        const meta = (json as MaybeHasVercelProviderMetadata).provider_metadata;
        if (meta) {
          providerMetadata = meta;
          inference_provider = meta.gateway?.routing?.finalProvider ?? inference_provider;
        }
      }
    },
  });

  const wasAborted = await drainSseStream(
    stream,
    chunk => sseStreamParser.feed(chunk),
    streamProcessingSpan
  );

  if (!reportedError && !usage) {
    captureMessage('SUSPICIOUS: No usage in Messages API stream', {
      level: 'warning',
      tags: { source: 'messages_usage_processing' },
      extra: { kiloUserId, provider, messageId, model },
    });
  }

  const coreProps = {
    messageId,
    hasError: reportedError || wasAborted,
    model,
    responseContent,
    inference_provider,
    finish_reason,
    upstream_id: null,
    latency: null,
    moderation_latency: null,
    generation_time: null,
    streamed: true,
    cancelled: null,
    status_code: statusCode,
  } satisfies NotYetCostedUsageStats;

  const costs = processMessagesApiUsage(usage, providerMetadata, coreProps);
  return { ...coreProps, ...costs };
}

export function parseMessagesMicrodollarUsageFromString(
  fullResponse: string,
  statusCode: number
): MicrodollarUsageStats {
  const responseJson = JSON.parse(fullResponse) as
    | (Anthropic.Messages.Message & MaybeHasVercelProviderMetadata)
    | null;

  const usage = responseJson?.usage;
  const providerMetadata = responseJson?.provider_metadata ?? null;
  const inference_provider = providerMetadata?.gateway?.routing?.finalProvider ?? null;

  const responseContent = (responseJson?.content ?? [])
    .filter((c): c is Anthropic.Messages.TextBlock => c != null && c.type === 'text')
    .map(c => c.text)
    .join('');

  const coreProps = {
    messageId: responseJson?.id ?? null,
    hasError: !responseJson?.model || statusCode >= 400,
    model: responseJson?.model ?? null,
    responseContent,
    inference_provider,
    upstream_id: null,
    finish_reason: responseJson?.stop_reason ?? null,
    latency: null,
    moderation_latency: null,
    generation_time: null,
    streamed: false,
    cancelled: null,
    status_code: statusCode,
  } satisfies NotYetCostedUsageStats;

  const costs = processMessagesApiUsage(usage, providerMetadata, coreProps);
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
