import type { CustomPricingConfig } from '@kilocode/db/schema-types';
import { NextResponse } from 'next/server';
import {
  getOutputHeaders,
  wrapInSafeNextResponse,
} from '@kilocode/web-shared/lib/ai-gateway/llm-proxy-helpers';
import {
  computeOpenRouterCosts,
  computeVercelCostFields,
  extractVercelIsByok,
} from '@kilocode/web-shared/lib/ai-gateway/processUsage.shared';
import type {
  JustTheCostsUsageStats,
  MicrodollarUsageContext,
} from '@kilocode/web-shared/lib/ai-gateway/processUsage.types';
import {
  readResponseText,
  rewriteResponseMetadata,
  rewriteUsageCost,
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
  if (usage) {
    // Vercel reports its cost in the body's provider metadata when `usage.cost` is absent.
    const gateway = (body.provider_metadata ?? body.providerMetadata)?.gateway;
    const vercelCosts = gateway && computeVercelCostFields(gateway, extractVercelIsByok(gateway));
    const costs: JustTheCostsUsageStats = {
      ...(usage.cost == null && usage.is_byok == null && vercelCosts
        ? vercelCosts
        : computeOpenRouterCosts(usage, context.provider)),
      inputTokens: usage.prompt_tokens ?? usage.input_tokens ?? 0,
      outputTokens: usage.completion_tokens ?? usage.output_tokens ?? 0,
      cacheHitTokens: 0,
      cacheWriteTokens: 0,
      is_byok: usage.is_byok ?? null,
    };
    rewriteUsageCost(usage, costs, context, gateway, vercelCosts);
  }
  rewriteResponseMetadata(body, context);
}

/**
 * Rewrites a successful JSON response of an endpoint that is not streamed, so its cost and model
 * match what the chat endpoints report. An error response, or a body that is not a JSON object,
 * passes through.
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
  const headers = getOutputHeaders(response);
  const textResult = await readResponseText(response, headers, vercelRequestId, null, null);
  if ('errorResponse' in textResult) return textResult.errorResponse;
  const { text } = textResult;

  const passThrough = () =>
    new NextResponse(text, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return passThrough();
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return passThrough();

  rewriteUsageEndpointBody(body, usageContext);
  return NextResponse.json(body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
