import { captureMessage } from '@sentry/nextjs';
import type { Span } from '@sentry/nextjs';
import { toMicrodollars } from '../utils';
import { OPENROUTER_BYOK_COST_MULTIPLIER } from '@/lib/ai-gateway/processUsage.constants';
import type {
  NotYetCostedUsageStats,
  VercelProviderMetaData,
} from '@/lib/ai-gateway/processUsage.types';

type OpenRouterCostFields = {
  cost?: number;
  is_byok?: boolean | null;
  cost_details?: { upstream_inference_cost: number };
};

/**
 * Computes cost_mUsd and is_byok from OpenRouter usage cost fields, and emits a
 * Sentry warning when the accounting looks suspicious.
 */
export function computeOpenRouterCostFields(
  usage: OpenRouterCostFields,
  coreProps: NotYetCostedUsageStats,
  source: string
): { cost_mUsd: number; is_byok: boolean | null } {
  const is_byok = usage.is_byok ?? null;
  const openrouterCost_USD = usage.cost ?? 0;
  const upstream_inference_cost_USD = usage.cost_details?.upstream_inference_cost ?? 0;
  const cost_mUsd = toMicrodollars(is_byok ? upstream_inference_cost_USD : openrouterCost_USD);
  const inferredUpstream_USD = openrouterCost_USD * OPENROUTER_BYOK_COST_MULTIPLIER;
  const microdollar_error = (inferredUpstream_USD - upstream_inference_cost_USD) * 1000000;
  if (
    (is_byok == null && (openrouterCost_USD || upstream_inference_cost_USD)) || // unknown byok status but known non-zero costs? We're borked!
    (is_byok && usage.cost !== 0 && 1.1 < Math.abs(microdollar_error)) // byok and cost is not 5% of upstream? Weird, EXCEPT sometimes cost is 0 due to openrouter promo.
  ) {
    const { responseContent: _ignore, ...corePropsCopy } = coreProps;
    captureMessage("SUSPICIOUS: openrouters cost accounting doesn't make sense", {
      level: 'error',
      tags: { source },
      extra: {
        ...corePropsCopy,
        cost_mUsd,
        is_byok,
        openrouterCost_USD,
        upstream_inference_cost_USD,
        inferredUpstream_USD,
        microdollar_error,
      },
    });
  }
  return { cost_mUsd, is_byok };
}

/**
 * Parses the Vercel gateway cost fields and returns cost in microdollars.
 * Prefers marketCost over cost; returns 0 if neither is a valid number.
 */
export function computeVercelCostMicrodollars(
  vercelGateway: NonNullable<VercelProviderMetaData['gateway']>
): number {
  const marketCost_USD = parseFloat(vercelGateway.marketCost ?? vercelGateway.cost ?? '0');
  return toMicrodollars(isNaN(marketCost_USD) ? 0 : marketCost_USD);
}

/**
 * Drains a ReadableStream of binary chunks, calling `onTextChunk` for each
 * decoded piece of text. Handles client-abort (`ResponseAborted`) gracefully
 * and always releases the reader lock and ends `streamProcessingSpan`.
 *
 * Returns `true` if the stream was aborted before completion.
 */
export async function drainSseStream(
  stream: ReadableStream<Uint8Array>,
  onTextChunk: (text: string) => void,
  streamProcessingSpan: Span
): Promise<boolean> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let wasAborted = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      onTextChunk(decoder.decode(value, { stream: true }));
    }
  } catch (error) {
    if (error instanceof Error && error.name === 'ResponseAborted') {
      wasAborted = true;
    } else {
      throw error;
    }
  } finally {
    reader.releaseLock();
    streamProcessingSpan.end();
  }
  return wasAborted;
}
