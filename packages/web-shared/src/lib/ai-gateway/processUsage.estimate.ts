import { getOpenRouterModelsMetadataFromDatabase } from '@kilocode/web-shared/lib/ai-gateway/providers/gateway-models-cache';
import { textRequestPriceCeiling } from '@kilocode/web-shared/lib/ai-gateway/request-cost-limit';
import { toMicrodollars } from '@kilocode/web-shared/lib/microdollars';
import type {
  MicrodollarUsageContext,
  MicrodollarUsageStats,
} from '@kilocode/web-shared/lib/ai-gateway/processUsage.types';

async function getTokenRates(model: string) {
  const models = await getOpenRouterModelsMetadataFromDatabase();
  const aliasTarget = model.startsWith('~') ? models[model]?.alias_target?.slug : undefined;
  const metadata = models[aliasTarget ?? model];
  if (!metadata) return null;
  try {
    return textRequestPriceCeiling(metadata);
  } catch {
    return null;
  }
}

/**
 * A successful response whose usage cannot be parsed still ran inference, so it
 * is charged an estimate instead of nothing: the request's estimated input
 * tokens, and output tokens from the response size capped at `max_tokens`,
 * priced at the model's most expensive route. Custom and Kilo-exclusive pricing
 * still apply to these token counts in `processTokenData`.
 */
export async function estimateUnparseableResponseUsage(
  responseText: string,
  usageContext: MicrodollarUsageContext,
  statusCode: number
): Promise<MicrodollarUsageStats> {
  const succeeded = statusCode < 400;
  const inputTokens = succeeded ? (usageContext.estimated_input_tokens ?? 0) : 0;
  const outputTokens = succeeded
    ? Math.min(
        Math.ceil(Buffer.byteLength(responseText, 'utf8') / 4),
        usageContext.max_tokens ?? Number.POSITIVE_INFINITY
      )
    : 0;
  const rates = succeeded ? await getTokenRates(usageContext.requested_model) : null;
  const cost = rates
    ? inputTokens * rates.inputRate + outputTokens * rates.outputRate + rates.requestCost
    : 0;

  return {
    messageId: null,
    model: null,
    responseContent: '',
    hasError: true,
    inference_provider: null,
    upstream_id: null,
    finish_reason: null,
    latency: null,
    moderation_latency: null,
    generation_time: null,
    streamed: usageContext.isStreaming,
    cancelled: null,
    status_code: statusCode,
    cost_mUsd: toMicrodollars(cost),
    inputTokens,
    outputTokens,
    cacheWriteTokens: 0,
    cacheHitTokens: 0,
    is_byok: null,
  };
}
