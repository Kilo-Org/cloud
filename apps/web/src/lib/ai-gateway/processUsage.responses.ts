import type { OpenAI } from 'openai';
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
import type { GatewayResponsesRequest } from '@/lib/ai-gateway/providers/openrouter/types';
import {
  computeOpenRouterCostFields,
  computeVercelCostMicrodollars,
  drainSseStream,
} from '@/lib/ai-gateway/processUsage.shared';

// OpenRouter adds cost fields to the standard Responses API usage object.
// ref: https://openrouter.ai/docs/use-cases/usage-accounting#response-format
type ResponsesApiUsage = OpenAI.Responses.ResponseUsage & {
  cost?: number;
  is_byok?: boolean | null;
  cost_details?: { upstream_inference_cost: number };
};

type MaybeHasVercelProviderMetadata = {
  provider_metadata?: VercelProviderMetaData;
};

type ResponsesApiResponse = OpenAI.Responses.Response &
  MaybeHasVercelProviderMetadata & {
    // OpenRouter may return a top-level usage with cost fields
    usage?: ResponsesApiUsage | null;
  };

type ResponsesApiStreamEvent = {
  type: string;
  delta?: string;
  response?: ResponsesApiResponse;
  error?: { message: string; code: string };
};

export function processResponsesApiUsage(
  usage: ResponsesApiUsage | null | undefined,
  providerMetadata: VercelProviderMetaData | null | undefined,
  coreProps: NotYetCostedUsageStats
): JustTheCostsUsageStats {
  const inputTokens = usage?.input_tokens ?? 0;
  const outputTokens = usage?.output_tokens ?? 0;
  const cacheHitTokens = usage?.input_tokens_details?.cached_tokens ?? 0;

  // OpenRouter path: cost fields are present directly in usage
  if (usage?.cost != null || usage?.is_byok != null) {
    const { cost_mUsd, is_byok } = computeOpenRouterCostFields(
      usage,
      coreProps,
      'responses_sse_processing'
    );
    return { inputTokens, outputTokens, cacheHitTokens, cacheWriteTokens: 0, cost_mUsd, is_byok };
  }

  // Vercel path: cost is in provider_metadata.gateway
  const vercelGateway = providerMetadata?.gateway;
  if (vercelGateway?.marketCost != null || vercelGateway?.cost != null) {
    const cost_mUsd = computeVercelCostMicrodollars(vercelGateway);
    return {
      inputTokens,
      outputTokens,
      cacheHitTokens,
      cacheWriteTokens: 0,
      cost_mUsd,
      is_byok: null,
    };
  }

  // No cost info available
  return {
    inputTokens,
    outputTokens,
    cacheHitTokens,
    cacheWriteTokens: 0,
    cost_mUsd: 0,
    is_byok: null,
  };
}

function extractResponseContent(output: OpenAI.Responses.ResponseOutputItem[]): string {
  return output
    .flatMap(item =>
      item.type === 'message'
        ? item.content
            .filter((c): c is OpenAI.Responses.ResponseOutputText => c.type === 'output_text')
            .map(c => c.text)
        : []
    )
    .join('');
}

export async function parseResponsesMicrodollarUsageFromStream(
  stream: ReadableStream,
  kiloUserId: string,
  openrouterRequestSpan: Span | undefined,
  provider: ProviderId,
  statusCode: number
): Promise<MicrodollarUsageStats> {
  openrouterRequestSpan?.end();
  const streamProcessingSpan = startInactiveSpan({
    name: 'responses-stream-processing',
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
  let usage: ResponsesApiUsage | null = null;
  let providerMetadata: VercelProviderMetaData | null = null;
  let inference_provider: string | null = null;
  let finish_reason: string | null = null;

  const sseStreamParser = createParser({
    onEvent(event: EventSourceMessage) {
      if (!firstTokenReceived) {
        sentryRootSpan()?.setAttribute(
          'responses.time_to_first_token_ms',
          performance.now() - startedAt
        );
        firstTokenReceived = true;
        timeToFirstTokenSpan.end();
      }

      if (event.data === '[DONE]') {
        return;
      }

      const json = JSON.parse(event.data) as ResponsesApiStreamEvent;

      if (!json) {
        captureException(new Error('SUSPICIOUS: No JSON in SSE event'), {
          extra: { event },
        });
        return;
      }

      if ('error' in json && json.error) {
        reportedError = true;
        captureException(new Error(`Responses API error: ${json.error.message}`), {
          tags: { source: 'responses_sse_processing' },
          extra: { json, event },
        });
      }

      if (json.type === 'response.output_text.delta' && json.delta) {
        responseContent += json.delta;
      }

      // Extract metadata whenever json.response is present so that aborted
      // streams still capture messageId/model/usage from early events like
      // response.created and response.in_progress.
      if (json.response) {
        const response = json.response;
        messageId = response.id ?? messageId;
        model = response.model ?? model;
        if (response.usage) {
          usage = response.usage as ResponsesApiUsage;
        }
        const meta = response.provider_metadata;
        if (meta) {
          providerMetadata = meta;
          inference_provider = meta.gateway?.routing?.finalProvider ?? inference_provider;
        }
        finish_reason = response.status ?? finish_reason;
      }

      if (json.type === 'response.failed' || json.type === 'response.incomplete') {
        reportedError = true;
      }
    },
  });

  const wasAborted = await drainSseStream(
    stream,
    chunk => sseStreamParser.feed(chunk),
    streamProcessingSpan
  );

  if (!reportedError && !usage) {
    captureMessage('SUSPICIOUS: No usage in Responses API stream', {
      level: 'warning',
      tags: { source: 'responses_usage_processing' },
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
  } satisfies NotYetCostedUsageStats;

  const costs = processResponsesApiUsage(usage, providerMetadata, coreProps);
  return { ...coreProps, ...costs };
}

export function parseResponsesMicrodollarUsageFromString(
  fullResponse: string,
  statusCode: number
): MicrodollarUsageStats {
  const responseJson = JSON.parse(fullResponse) as ResponsesApiResponse | null;

  const usage = responseJson?.usage;
  const providerMetadata = responseJson?.provider_metadata ?? null;

  const inference_provider = providerMetadata?.gateway?.routing?.finalProvider ?? null;

  const coreProps = {
    messageId: responseJson?.id ?? null,
    hasError: !responseJson?.model || statusCode >= 400 || responseJson?.status !== 'completed',
    model: responseJson?.model ?? null,
    responseContent: responseJson?.output ? extractResponseContent(responseJson.output) : '',
    inference_provider,
    upstream_id: null,
    finish_reason: responseJson?.status ?? null,
    latency: null,
    moderation_latency: null,
    generation_time: null,
    streamed: false,
    cancelled: null,
  } satisfies NotYetCostedUsageStats;

  const costs = processResponsesApiUsage(usage, providerMetadata, coreProps);
  return { ...coreProps, ...costs };
}

export function extractInputItemTextContent(
  item: OpenAI.Responses.ResponseInputItem
): string | null {
  if (!('role' in item) || !('content' in item)) return null;
  if (item.role !== 'user') return null;
  const { content } = item;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((c): c is OpenAI.Responses.ResponseInputText => c.type === 'input_text')
      .map(c => c.text)
      .join('\n');
  }
  return null;
}

export function extractResponsesPromptInfo(body: GatewayResponsesRequest): PromptInfo {
  const instructions = body.instructions ?? '';

  let userPrompt = '';
  if (typeof body.input === 'string') {
    userPrompt = body.input;
  } else if (Array.isArray(body.input)) {
    const lastUserText = body.input
      .map(extractInputItemTextContent)
      .filter((t): t is string => t !== null)
      .at(-1);
    userPrompt = lastUserText ?? '';
  }

  return {
    system_prompt_prefix: instructions.slice(0, 100),
    system_prompt_length: instructions.length,
    user_prompt_prefix: userPrompt.slice(0, 100),
  };
}
