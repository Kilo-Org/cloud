import type { CustomPricingConfig } from '@kilocode/db/schema-types';
import type { GatewayRequest } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/types';
import { getReasoningEffortTimeoutSuggestion } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/request-helpers';
import { UpstreamTimeoutError } from '@kilocode/web-shared/lib/ai-gateway/providers/upstream-request';
import {
  computeOpenRouterCosts,
  computeVercelCostFields,
  extractVercelIsByok,
  getUpstreamBodyTermination,
} from '@kilocode/web-shared/lib/ai-gateway/processUsage.shared';
import type {
  JustTheCostsUsageStats,
  MicrodollarUsageContext,
  VercelProviderMetaData,
} from '@kilocode/web-shared/lib/ai-gateway/processUsage.types';
import { applyUsagePricing } from '@kilocode/web-shared/lib/ai-gateway/usage-cost';
import { OPENAI_CHATGPT_PROVIDER_ID } from '@kilocode/web-shared/lib/ai-gateway/openai-chatgpt/provider-id';
import { CLAUDE_BILLING_PROVIDER_ID } from '@kilocode/web-shared/lib/ai-gateway/claude-billing/provider-id';
import { errorExceptInTest, logExceptInTest } from '@kilocode/web-shared/lib/utils.server';
import { withRequestId } from '@kilocode/web-shared/lib/ai-gateway/request-id';
import type { createParser } from 'eventsource-parser';
import { NextResponse } from 'next/server';

/**
 * Handle passed to the response pipeline so the upstream response body can be
 * captured for request logging while the response is being processed anyway.
 * This way the event stream is only processed once, instead of once for
 * logging and once for rewriting.
 */
export type RequestLogCapture = {
  /** Only the first generation ID is kept. */
  setGenerationId(id: string): void;
  setBody(text: string): void;
  setReadError(error: unknown, partialBody?: string): void;
};

export type RewriteResponseParams = {
  response: Response;
  usageContext: ResponseUsageContext;
  capture: RequestLogCapture | null;
  vercelRequestId: string | null;
  reasoningEffort: string | null;
};

export type ResponseUsageContext = Pick<
  MicrodollarUsageContext,
  'requested_model' | 'provider' | 'is_free' | 'user_byok' | 'api_kind' | 'custom_llm_pricing'
> & {
  custom_pricing_config: CustomPricingConfig;
};

export type ResponseUsage = {
  cost?: number;
  is_byok?: boolean | null;
  cost_details?: { upstream_inference_cost?: number | null };
  market_cost?: number;
  gateway_cost?: number;
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_tokens_details?: {
    cached_tokens?: number;
    cache_write_tokens?: number;
    cache_creation_input_tokens?: number;
  };
  completion_tokens_details?: { reasoning_tokens?: number };
  input_tokens?: number | null;
  output_tokens?: number;
  input_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
};

export type ResponseMetadata = {
  id?: string;
  model?: string;
  provider_metadata?: VercelProviderMetaData;
  providerMetadata?: VercelProviderMetaData;
};

function isModelRewriteExempt(model: string): boolean {
  return (
    model.startsWith('~') ||
    model.startsWith('openrouter/') ||
    model === 'typesafe/jev-router' ||
    model === 'nvidia/switchyard'
  );
}

export function rewriteResponseMetadata(value: ResponseMetadata, context: ResponseUsageContext) {
  if (value.model !== undefined && !isModelRewriteExempt(context.requested_model)) {
    value.model = context.requested_model;
  }
  if (value.provider_metadata !== undefined || value.providerMetadata !== undefined) {
    console.debug('[rewriteModelResponse] removing upstream provider metadata');
    delete value.provider_metadata;
    delete value.providerMetadata;
  }
}

export type ResponseReadError = {
  errorType: 'timeout' | 'upstream_disconnect';
  /** Already carries the request id suffix when one is available. */
  message: string;
};

const STREAM_PROGRESS_LOG_INTERVAL_MS = 30_000;

export function createStreamProgressLogger() {
  let eventCount = 0;
  const interval = setInterval(() => {
    logExceptInTest('[rewriteModelResponse] stream progress', {
      eventCount,
    });
  }, STREAM_PROGRESS_LOG_INTERVAL_MS);

  return {
    eventProcessed() {
      eventCount += 1;
    },
    stop() {
      clearInterval(interval);
    },
  };
}

export function logTerminalStreamEvent(
  kind: GatewayRequest['kind'],
  eventType: string,
  generationId: string | undefined,
  vercelRequestId: string | null | undefined
) {
  logExceptInTest('[rewriteModelResponse] received terminal stream event', {
    kind,
    eventType,
    generationId: generationId ?? '<none>',
    vercelRequestId: vercelRequestId ?? '<none>',
  });
}

function getResponseReadError(
  error: unknown,
  vercelRequestId: string | null | undefined,
  reasoningEffort: string | null
): ResponseReadError | null {
  if (typeof error !== 'object' || error === null || !('name' in error)) {
    return null;
  }

  const upstreamBodyTermination = getUpstreamBodyTermination(error);

  if (error.name === 'ResponseAborted' || upstreamBodyTermination === 'disconnect') {
    return {
      errorType: 'upstream_disconnect',
      message: withRequestId(
        'The upstream response was interrupted while streaming. The provider may have disconnected or the request may have timed out.' +
          getReasoningEffortTimeoutSuggestion(reasoningEffort),
        vercelRequestId
      ),
    };
  }

  // The gateway's own duration budget, not a provider timeout: the headers
  // arrived, so the stream was still open when the budget ran out.
  if (error instanceof UpstreamTimeoutError) {
    return {
      errorType: 'timeout',
      message: withRequestId(
        `The response reached the gateway's ${Math.round(error.limitMs / 1000)}-second duration limit and was stopped before it finished.` +
          getReasoningEffortTimeoutSuggestion(reasoningEffort),
        vercelRequestId
      ),
    };
  }

  if (error.name === 'TimeoutError' || upstreamBodyTermination === 'timeout') {
    return {
      errorType: 'timeout',
      message: withRequestId(
        'The upstream provider timed out while sending the response.' +
          getReasoningEffortTimeoutSuggestion(reasoningEffort),
        vercelRequestId
      ),
    };
  }

  return null;
}

export async function readResponseText(
  response: Response,
  headers: Headers,
  vercelRequestId: string | null | undefined,
  capture: RequestLogCapture | null,
  reasoningEffort: string | null
): Promise<{ text: string } | { error: unknown; errorResponse: NextResponse }> {
  try {
    return { text: await response.text() };
  } catch (error) {
    const responseReadError = getResponseReadError(error, vercelRequestId, reasoningEffort);
    if (!responseReadError) {
      // Settle the capture so the after() callback awaiting it does not hang
      // and the request is still logged (without a response body).
      capture?.setReadError(error);
      throw error;
    }

    return {
      error,
      errorResponse: NextResponse.json(
        {
          error: responseReadError.message,
          error_type: responseReadError.errorType,
          message: responseReadError.message,
        },
        { status: 503, headers }
      ),
    };
  }
}

/**
 * Rewrites a non-streamed JSON response body in place with `mutate`. A body that is not valid
 * JSON, or whose JSON is not an object, passes through unchanged. A body that cannot be read
 * returns the read-error response.
 */
export async function rewriteJsonResponse<Body extends object>({
  response,
  headers,
  vercelRequestId,
  capture,
  reasoningEffort,
  mutate,
}: {
  response: Response;
  headers: Headers;
  vercelRequestId: string | null | undefined;
  capture: RequestLogCapture | null;
  reasoningEffort: string | null;
  mutate: (body: Body) => void;
}): Promise<NextResponse> {
  // Read the body text once to avoid "Response body object should not be
  // disturbed or locked" errors that occur when `.clone().json()` fails.
  const textResult = await readResponseText(
    response,
    headers,
    vercelRequestId,
    capture,
    reasoningEffort
  );
  if ('errorResponse' in textResult) {
    capture?.setReadError(textResult.error);
    return textResult.errorResponse;
  }
  const { text } = textResult;
  capture?.setBody(text);
  const init = { status: response.status, statusText: response.statusText, headers };
  let body: Body | null;
  try {
    body = JSON.parse(text) as Body | null;
  } catch {
    // Upstream returned invalid/empty JSON body — pass through as-is
    return new NextResponse(text, init);
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return new NextResponse(text, init);
  }
  mutate(body);
  return NextResponse.json(body, init);
}

export function partialCapturedBody(capturedChunks: string[] | null): string | undefined {
  return capturedChunks && capturedChunks.length > 0 ? capturedChunks.join('') : undefined;
}

export async function rewriteSseStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  parser: ReturnType<typeof createParser>,
  controller: ReadableStreamDefaultController<string>,
  doneReceived: () => boolean,
  terminalEventReceived: () => boolean,
  serializeError: (error: ResponseReadError) => string,
  onFinally: () => void,
  vercelRequestId: string | null | undefined,
  capture: RequestLogCapture | null,
  capturedChunks: string[] | null,
  reasoningEffort: string | null
) {
  const decoder = new TextDecoder();
  const settleReadError = (error: unknown) =>
    capture?.setReadError(error, partialCapturedBody(capturedChunks));
  const settleBody = () => {
    if (capturedChunks) {
      capturedChunks.push(decoder.decode());
      capture?.setBody(capturedChunks.join(''));
    }
  };
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        // Flush any event left buffered when the stream ends without a
        // trailing blank line, so its data isn't silently dropped.
        parser.reset({ consume: true });
        if (doneReceived()) {
          controller.enqueue('data: [DONE]\n\n');
        }
        controller.close();
        settleBody();
        return;
      }
      const chunk = decoder.decode(value, { stream: true });
      capturedChunks?.push(chunk);
      parser.feed(chunk);
      if (terminalEventReceived()) {
        if (doneReceived()) {
          controller.enqueue('data: [DONE]\n\n');
        }
        const cancellation = reader.cancel();
        controller.close();
        settleBody();
        try {
          await cancellation;
        } catch (error) {
          errorExceptInTest(
            '[rewriteModelResponse] failed to cancel terminal upstream stream',
            error
          );
        }
        return;
      }
    }
  } catch (error) {
    const responseReadError = getResponseReadError(error, vercelRequestId, reasoningEffort);
    if (!responseReadError) {
      settleReadError(error);
      throw error;
    }

    errorExceptInTest('[rewriteModelResponse] emitting stream error event', {
      ...responseReadError,
      vercelRequestId: vercelRequestId ?? '<none>',
    });
    settleReadError(error);
    controller.enqueue(serializeError(responseReadError));
    controller.close();
  } finally {
    onFinally();
    reader.releaseLock();
  }
}

/**
 * Replaces the upstream's cost fields with what Kilo bills: custom pricing applied, and free,
 * BYOK and subscription-funded requests at zero. Shared by every endpoint whose response carries
 * an OpenRouter-style `usage` object.
 */
function rewriteUsageCost(
  usage: ResponseUsage,
  costs: JustTheCostsUsageStats,
  context: ResponseUsageContext,
  gateway: NonNullable<VercelProviderMetaData['gateway']> | undefined,
  vercelCosts: ReturnType<typeof computeVercelCostFields> | undefined
) {
  applyUsagePricing(costs, context, context.custom_pricing_config);
  usage.cost = costs.cost_mUsd / 1_000_000;
  usage.is_byok =
    context.user_byok ||
    context.provider === OPENAI_CHATGPT_PROVIDER_ID ||
    context.provider === CLAUDE_BILLING_PROVIDER_ID;
  if (
    usage.cost_details?.upstream_inference_cost == null &&
    gateway &&
    (gateway.marketCost != null || gateway.cost != null)
  ) {
    usage.cost_details = {
      ...usage.cost_details,
      upstream_inference_cost:
        ((vercelCosts?.cost_mUsd ?? 0) - (vercelCosts?.nonInferenceCost_mUsd ?? 0)) / 1_000_000,
    };
  }
  delete usage.market_cost;
  delete usage.gateway_cost;
}

/**
 * Prices `usage` from its token counts and replaces its cost fields with what Kilo bills.
 * Vercel reports its cost in the provider metadata, which `preferVercelCost` allows when the usage
 * carries no cost of its own. Returns the computed costs.
 */
export function rewriteUsageFromTokens({
  usage,
  context,
  providerMetadata,
  tokens,
  preferVercelCost,
}: {
  usage: ResponseUsage;
  context: ResponseUsageContext;
  providerMetadata: VercelProviderMetaData | undefined;
  tokens: Pick<
    JustTheCostsUsageStats,
    'inputTokens' | 'outputTokens' | 'cacheHitTokens' | 'cacheWriteTokens'
  >;
  preferVercelCost: boolean;
}): JustTheCostsUsageStats {
  const gateway = providerMetadata?.gateway;
  const vercelCosts = gateway && computeVercelCostFields(gateway, extractVercelIsByok(gateway));
  const costs: JustTheCostsUsageStats = {
    ...(preferVercelCost && usage.cost == null && usage.is_byok == null && vercelCosts
      ? vercelCosts
      : computeOpenRouterCosts(usage, context.provider)),
    ...tokens,
    is_byok: usage.is_byok ?? null,
  };
  rewriteUsageCost(usage, costs, context, gateway, vercelCosts);
  return costs;
}

export function rewriteUsage(
  usage: ResponseUsage,
  context: ResponseUsageContext,
  providerMetadata?: VercelProviderMetaData,
  startUsage?: ResponseUsage
) {
  const isMessages = context.api_kind === 'messages';
  const isChat = context.api_kind === 'chat_completions';
  const cacheHitTokens = isChat
    ? (usage.prompt_tokens_details?.cached_tokens ?? 0)
    : isMessages
      ? (usage.cache_read_input_tokens ?? startUsage?.cache_read_input_tokens ?? 0)
      : (usage.input_tokens_details?.cached_tokens ?? 0);
  const cacheWriteTokens = isChat
    ? (usage.prompt_tokens_details?.cache_write_tokens ??
      usage.prompt_tokens_details?.cache_creation_input_tokens ??
      0)
    : isMessages
      ? (usage.cache_creation_input_tokens ?? startUsage?.cache_creation_input_tokens ?? 0)
      : (usage.input_tokens_details?.cache_write_tokens ?? 0);
  rewriteUsageFromTokens({
    usage,
    context,
    providerMetadata,
    tokens: {
      inputTokens: isChat
        ? (usage.prompt_tokens ?? 0)
        : isMessages
          ? (usage.input_tokens ?? startUsage?.input_tokens ?? 0) +
            cacheHitTokens +
            cacheWriteTokens
          : (usage.input_tokens ?? 0),
      outputTokens: isChat ? (usage.completion_tokens ?? 0) : (usage.output_tokens ?? 0),
      cacheHitTokens,
      cacheWriteTokens,
    },
    preferVercelCost: !isChat,
  });
  if (usage.prompt_tokens_details) {
    if (usage.prompt_tokens_details.cached_tokens === undefined) {
      usage.prompt_tokens_details.cached_tokens = 0; // OpenCode crashes if this is absent
    }
  }
  if (usage.completion_tokens_details) {
    if (usage.completion_tokens_details.reasoning_tokens === undefined) {
      usage.completion_tokens_details.reasoning_tokens = 0; // strict OpenRouter clients reject a details object that omits this
    }
  }
}
