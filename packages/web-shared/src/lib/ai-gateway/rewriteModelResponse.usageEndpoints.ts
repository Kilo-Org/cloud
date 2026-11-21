import type { CustomPricingConfig } from '@kilocode/db/schema-types';
import { NextResponse } from 'next/server';
import {
  getOutputHeaders,
  wrapInSafeNextResponse,
} from '@kilocode/web-shared/lib/ai-gateway/llm-proxy-helpers';
import type { ReadResponseBody } from '@kilocode/web-shared/lib/ai-gateway/processUsage.shared';
import type {
  JustTheCostsUsageStats,
  MicrodollarUsageContext,
} from '@kilocode/web-shared/lib/ai-gateway/processUsage.types';
import {
  responseReadErrorResponse,
  rewriteBilledUsage,
  rewriteJsonBody,
  rewriteJsonResponse,
  rewriteResponseMetadata,
  rewriteUsageFromTokens,
  type ResponseMetadata,
  type ResponseUsage,
  type ResponseUsageContext,
} from '@kilocode/web-shared/lib/ai-gateway/rewriteModelResponse.shared';

type UsageEndpointBody = ResponseMetadata & { usage?: ResponseUsage | null };

/** The slice of the accounting context that decides what the response reports. */
export function responseUsageContext(
  usageContext: MicrodollarUsageContext,
  customPricingConfig: CustomPricingConfig
): ResponseUsageContext {
  return {
    requested_model: usageContext.requested_model,
    provider: usageContext.provider,
    api_kind: usageContext.api_kind,
    is_free: usageContext.is_free,
    user_byok: usageContext.user_byok,
    custom_llm_pricing: usageContext.custom_llm_pricing,
    custom_pricing_config: customPricingConfig,
  };
}

/**
 * Applies to the embeddings, transcriptions and System One bodies the rewrites chat responses
 * already get: the model is the id the caller asked for, `usage.cost` is what Kilo bills, and no
 * upstream provider metadata leaks. Mutates `body`.
 */
export function rewriteUsageEndpointBody(body: UsageEndpointBody, context: ResponseUsageContext) {
  const usage = body.usage;
  // OpenRouter transcriptions report no `is_byok`, and the ledger prices them from the generation
  // lookup, because a BYOK-served one reports only the fee. A paid cost the response cannot verify
  // stays as the upstream reported it instead of claiming a billed amount that may be too low,
  // unless custom pricing replaces it, which derives from the token counts.
  const costIsUnverified =
    context.api_kind === 'audio_transcriptions' && usage?.is_byok == null && !context.is_free;
  if (typeof usage === 'object' && usage !== null && !Array.isArray(usage)) {
    const reported = { cost: usage.cost, is_byok: usage.is_byok, cost_details: usage.cost_details };
    const costs = rewriteUsageFromTokens({
      usage,
      context,
      // Vercel reports its cost in the body's provider metadata when `usage.cost` is absent.
      providerMetadata: body.provider_metadata ?? body.providerMetadata,
      tokens: {
        inputTokens: usage.prompt_tokens ?? usage.input_tokens ?? 0,
        outputTokens: usage.completion_tokens ?? usage.output_tokens ?? 0,
        cacheHitTokens: 0,
        cacheWriteTokens: 0,
      },
      preferVercelCost: true,
    });
    if (costIsUnverified && costs.cost_mUsd === costs.market_cost) {
      for (const [key, value] of Object.entries(reported)) {
        if (value === undefined) delete usage[key as keyof typeof reported];
        else Object.assign(usage, { [key]: value });
      }
    }
  }
  rewriteResponseMetadata(body, context);
}

/**
 * Applies the rewrites of `rewriteUsageEndpointBody`, but reports the cost the ledger already
 * billed instead of pricing the body again. Mutates `body`.
 */
export function rewriteBilledUsageEndpointBody(
  body: UsageEndpointBody,
  billed: Pick<JustTheCostsUsageStats, 'cost_mUsd'>,
  context: ResponseUsageContext
) {
  const usage = body.usage;
  if (typeof usage === 'object' && usage !== null && !Array.isArray(usage)) {
    rewriteBilledUsage(usage, billed, context, body.provider_metadata ?? body.providerMetadata);
  }
  rewriteResponseMetadata(body, context);
}

/**
 * Builds the response of an endpoint that is not streamed from the body its accounting already
 * read, so the body is read and parsed once. A successful JSON body reports the requested model
 * and the cost the ledger bills, or, when the accounting could not price it, the cost
 * `rewriteUsageEndpointBody` computes. An error response, a body that is not JSON, and a JSON body
 * that is not an object pass through.
 */
export async function rewriteBilledResponse_UsageEndpoint({
  response,
  body,
  billed,
  usageContext,
  vercelRequestId,
}: {
  response: Response;
  body: Promise<ReadResponseBody | null>;
  billed: Promise<Pick<JustTheCostsUsageStats, 'cost_mUsd'> | null>;
  usageContext: ResponseUsageContext;
  vercelRequestId: string | null;
}): Promise<NextResponse> {
  const headers = getOutputHeaders(response);
  const init = { status: response.status, statusText: response.statusText, headers };
  let read: ReadResponseBody | null;
  try {
    read = await body;
  } catch (error) {
    const errorResponse = responseReadErrorResponse(error, headers, vercelRequestId, null);
    if (!errorResponse) throw error;
    return errorResponse;
  }
  if (!read) return new NextResponse(null, init);
  if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) {
    return new NextResponse(read.text, init);
  }
  // A pricing failure fails the ledger write, not the response.
  const billedCosts = await billed.catch(() => null);
  return rewriteJsonBody<UsageEndpointBody>(read, init, responseBody => {
    if (billedCosts) rewriteBilledUsageEndpointBody(responseBody, billedCosts, usageContext);
    else rewriteUsageEndpointBody(responseBody, usageContext);
  });
}

/**
 * Rewrites a successful JSON response of an endpoint that is not streamed, so its cost and model
 * match what the chat endpoints report. An error response, a body that is not
 * JSON, and a JSON body that is not an object pass through.
 */
export async function rewriteModelResponse_UsageEndpoint({
  response,
  usageContext,
  vercelRequestId,
}: {
  response: Response;
  usageContext: ResponseUsageContext;
  vercelRequestId: string | null;
}): Promise<NextResponse> {
  if (!response.ok) return wrapInSafeNextResponse(response);
  // `response_format` can ask for a plain-text body, which is never rewritten.
  if (!response.headers.get('content-type')?.includes('application/json')) {
    return wrapInSafeNextResponse(response);
  }
  return rewriteJsonResponse<UsageEndpointBody>({
    response,
    headers: getOutputHeaders(response),
    vercelRequestId,
    capture: null,
    reasoningEffort: null,
    mutate: body => rewriteUsageEndpointBody(body, usageContext),
  });
}
