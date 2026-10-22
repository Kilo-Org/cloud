import { captureMessage } from '@sentry/nextjs';
import type { Span } from '@sentry/nextjs';
import { toMicrodollars } from '@kilocode/web-shared/lib/microdollars';
import { errorExceptInTest } from '@kilocode/web-shared/lib/utils.server';
import { OPENROUTER_BYOK_COST_MULTIPLIER } from '@kilocode/web-shared/lib/ai-gateway/processUsage.constants';
import type {
  JustTheCostsUsageStats,
  NotYetCostedUsageStats,
  VercelProviderAttempt,
  VercelProviderMetaData,
} from '@kilocode/web-shared/lib/ai-gateway/processUsage.types';
import type { ProviderId } from '@kilocode/web-shared/lib/ai-gateway/providers/types';

type OpenRouterCostFields = {
  cost?: number;
  is_byok?: boolean | null;
  cost_details?: { upstream_inference_cost: number };
};

function byokFee_USD(provider: ProviderId, upstreamInferenceCost_USD: number) {
  return provider === 'vercel' ? 0 : upstreamInferenceCost_USD / OPENROUTER_BYOK_COST_MULTIPLIER;
}

/**
 * On a BYOK request the provider bills inference to the key, and the gateway's
 * own `cost` is what it charged on top: add-ons such as server tools, plugins
 * and PDF parsing, plus OpenRouter's BYOK fee of 5% of the upstream cost. The
 * fee is not passed on. OpenRouter does not report it separately and waives it
 * for the first requests of a month, so add-ons are undercharged by up to the
 * fee then. Vercel charges no fee.
 */
export function byokAddonCost_mUsd(
  provider: ProviderId,
  gatewayCost_USD: number,
  upstreamInferenceCost_USD: number
): number {
  return Math.max(
    0,
    toMicrodollars(gatewayCost_USD - byokFee_USD(provider, upstreamInferenceCost_USD))
  );
}

/**
 * Computes the cost and BYOK status from OpenRouter-style usage cost fields,
 * which Vercel also returns, and emits a Sentry warning when the accounting
 * looks suspicious.
 */
export function computeOpenRouterCostFields(
  usage: OpenRouterCostFields,
  coreProps: NotYetCostedUsageStats,
  source: string,
  provider: ProviderId
): Pick<JustTheCostsUsageStats, 'cost_mUsd' | 'addonCost_mUsd' | 'is_byok'> {
  const is_byok = usage.is_byok ?? null;
  const openrouterCost_USD = usage.cost ?? 0;
  const upstream_inference_cost_USD = usage.cost_details?.upstream_inference_cost ?? 0;
  const addonCost_mUsd = is_byok
    ? byokAddonCost_mUsd(provider, openrouterCost_USD, upstream_inference_cost_USD)
    : undefined;
  const cost_mUsd =
    addonCost_mUsd === undefined
      ? toMicrodollars(openrouterCost_USD)
      : toMicrodollars(upstream_inference_cost_USD) + addonCost_mUsd;
  const fee_USD = byokFee_USD(provider, upstream_inference_cost_USD);
  if (
    (is_byok == null && (openrouterCost_USD || upstream_inference_cost_USD)) || // unknown byok status but known non-zero costs? We're borked!
    // A BYOK charge is 0 while the fee is waived, and at least the fee otherwise.
    (is_byok && openrouterCost_USD > 0 && (fee_USD - openrouterCost_USD) * 1_000_000 > 1.1)
  ) {
    const { responseContent: _ignore, ...corePropsCopy } = coreProps;
    captureMessage("SUSPICIOUS: openrouters cost accounting doesn't make sense", {
      level: 'error',
      tags: { source },
      extra: {
        ...corePropsCopy,
        provider,
        cost_mUsd,
        addonCost_mUsd,
        is_byok,
        openrouterCost_USD,
        upstream_inference_cost_USD,
        fee_USD,
      },
    });
  }
  return { cost_mUsd, addonCost_mUsd, is_byok };
}

function parseUsd(value: string | undefined): number {
  const usd = parseFloat(value ?? '0');
  return isNaN(usd) ? 0 : usd;
}

/**
 * Computes the cost from the Vercel gateway metadata. `marketCost` is what the
 * request costs at list price, including native provider tools. On a BYOK
 * request the provider bills that to the key, and `cost` is what Vercel charged
 * on top for its own tools; otherwise `cost` already includes everything.
 */
export function computeVercelCostFields(
  vercelGateway: NonNullable<VercelProviderMetaData['gateway']>,
  isByok: boolean | null
): Pick<JustTheCostsUsageStats, 'cost_mUsd' | 'addonCost_mUsd'> {
  if (isByok && vercelGateway.marketCost != null) {
    const marketCost_USD = parseUsd(vercelGateway.marketCost);
    const addonCost_mUsd = byokAddonCost_mUsd(
      'vercel',
      parseUsd(vercelGateway.cost),
      marketCost_USD
    );
    return { cost_mUsd: toMicrodollars(marketCost_USD) + addonCost_mUsd, addonCost_mUsd };
  }
  return { cost_mUsd: toMicrodollars(parseUsd(vercelGateway.marketCost ?? vercelGateway.cost)) };
}

/**
 * Finds the provider attempt that served the request in the Vercel AI Gateway
 * routing metadata: the successful provider attempt within the successful model
 * attempt, falling back to the last attempt of each when none reports success.
 */
function findVercelServingProviderAttempt(
  vercelGateway: NonNullable<VercelProviderMetaData['gateway']> | undefined | null
): VercelProviderAttempt | undefined {
  const modelAttempts = vercelGateway?.routing?.modelAttempts;
  if (!modelAttempts) return undefined;
  const servingModel = modelAttempts.find(m => m.success) ?? modelAttempts.at(-1);
  const providerAttempts = servingModel?.providerAttempts;
  if (!providerAttempts) return undefined;
  return providerAttempts.find(p => p.success) ?? providerAttempts.at(-1);
}

/**
 * Extracts whether the Vercel AI Gateway served the request with BYOK credentials.
 *
 * The gateway reports per-attempt `credentialType` ("byok" | "system") in
 * `provider_metadata.gateway.routing.modelAttempts[].providerAttempts[]`. We look
 * at the successful provider attempt within the successful model attempt. Returns
 * `null` when credentialType is absent or no successful attempt is found.
 */
export function extractVercelIsByok(
  vercelGateway: NonNullable<VercelProviderMetaData['gateway']> | undefined | null
): boolean | null {
  const credentialType = findVercelServingProviderAttempt(vercelGateway)?.credentialType;
  if (credentialType === 'byok') return true;
  if (credentialType === 'system') return false;
  return null;
}

/**
 * Extracts the upstream provider's own request/response id from the Vercel AI
 * Gateway routing metadata, so it can be stored as
 * `microdollar_usage_metadata.upstream_id` without a `/generation` lookup.
 *
 * Mirrors the attempt selection of `extractVercelIsByok`. Returns `null` when
 * the gateway did not report an id.
 */
export function extractVercelUpstreamId(
  vercelProviderMetadata: VercelProviderMetaData | undefined | null
): string | null {
  const attempt = findVercelServingProviderAttempt(vercelProviderMetadata?.gateway);
  return attempt?.providerRequestId ?? attempt?.providerResponseId ?? null;
}

/**
 * Derives `generation_time` in milliseconds from the `startTime`/`endTime` of
 * the provider attempt that served the request, so Vercel AI Gateway usage gets
 * it without a `/generation` lookup. Returns `null` when either timestamp is
 * missing or the interval is negative.
 */
export function extractVercelGenerationTime(
  vercelProviderMetadata: VercelProviderMetaData | undefined | null
): number | null {
  const attempt = findVercelServingProviderAttempt(vercelProviderMetadata?.gateway);
  const startTime = attempt?.startTime;
  const endTime = attempt?.endTime;
  if (typeof startTime !== 'number' || typeof endTime !== 'number') return null;
  const generationTime = endTime - startTime;
  return Number.isFinite(generationTime) && generationTime >= 0 ? generationTime : null;
}

/**
 * Node's fetch (undici) fails a body read with `TypeError: terminated` when the
 * upstream connection breaks mid-body. The cause tells an idle body timeout
 * apart from a closed or reset socket.
 */
export function getUpstreamBodyTermination(error: unknown): 'timeout' | 'disconnect' | null {
  if (
    typeof error !== 'object' ||
    error === null ||
    !('name' in error) ||
    !('message' in error) ||
    error.name !== 'TypeError' ||
    error.message !== 'terminated'
  ) {
    return null;
  }
  const cause = 'cause' in error ? error.cause : undefined;
  const causeCode =
    typeof cause === 'object' && cause !== null && 'code' in cause ? cause.code : undefined;
  return causeCode === 'UND_ERR_BODY_TIMEOUT' ? 'timeout' : 'disconnect';
}

export function isResponseInterruptedError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('name' in error)) return false;
  return (
    error.name === 'ResponseAborted' ||
    error.name === 'TimeoutError' ||
    getUpstreamBodyTermination(error) !== null
  );
}

/**
 * Drains a ReadableStream of binary chunks, calling `onTextChunk` for each
 * decoded piece of text. Handles stream processing failures gracefully and
 * always releases the reader lock and ends `streamProcessingSpan`.
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
    errorExceptInTest('[processUsage] treating stream processing error as aborted', error);
    wasAborted = true;
  } finally {
    reader.releaseLock();
    streamProcessingSpan.end();
  }
  return wasAborted;
}
