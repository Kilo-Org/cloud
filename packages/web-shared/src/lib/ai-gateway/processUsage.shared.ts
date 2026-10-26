import { captureException, captureMessage } from '@sentry/nextjs';
import type { Span } from '@sentry/nextjs';
import { toMicrodollars } from '@kilocode/web-shared/lib/microdollars';
import { errorExceptInTest } from '@kilocode/web-shared/lib/utils.server';
import { OPENROUTER_BYOK_COST_MULTIPLIER } from '@kilocode/web-shared/lib/ai-gateway/processUsage.constants';
import type { ProviderId } from '@kilocode/web-shared/lib/ai-gateway/providers/types';
import type {
  NotYetCostedUsageStats,
  VercelProviderAttempt,
  VercelProviderMetaData,
} from '@kilocode/web-shared/lib/ai-gateway/processUsage.types';

type OpenRouterCostFields = {
  cost?: number;
  is_byok?: boolean | null;
  cost_details?: { upstream_inference_cost: number };
};

/**
 * Whether the provider reports `usage.is_byok` next to `usage.cost`. OpenRouter
 * does on chat completions, Messages, Responses and embeddings, and Vercel AI
 * Gateway does on chat completions. Martian reports `cost` in the same shape but
 * never `is_byok`.
 */
export function providerReportsIsByok(provider: ProviderId): boolean {
  return provider === 'openrouter' || provider === 'vercel';
}

/**
 * Computes cost_mUsd and is_byok from OpenRouter usage cost fields, and emits a
 * Sentry warning when the accounting looks suspicious.
 *
 * With BYOK, OpenRouter's `cost` is only its 5% fee and the real cost is
 * `cost_details.upstream_inference_cost`, so a cost without a BYOK status cannot
 * be trusted. `requireIsByok` says whether that is suspicious for this response.
 */
export function computeOpenRouterCostFields(
  usage: OpenRouterCostFields,
  coreProps: NotYetCostedUsageStats,
  source: string,
  requireIsByok: boolean
): { cost_mUsd: number; is_byok: boolean | null } {
  const is_byok = usage.is_byok ?? null;
  const openrouterCost_USD = usage.cost ?? 0;
  const upstream_inference_cost_USD = usage.cost_details?.upstream_inference_cost ?? 0;
  const cost_mUsd = toMicrodollars(is_byok ? upstream_inference_cost_USD : openrouterCost_USD);
  const inferredUpstream_USD = openrouterCost_USD * OPENROUTER_BYOK_COST_MULTIPLIER;
  const microdollar_error = (inferredUpstream_USD - upstream_inference_cost_USD) * 1000000;
  if (
    (requireIsByok && is_byok == null && (openrouterCost_USD || upstream_inference_cost_USD)) || // unknown byok status but known non-zero costs? We're borked!
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

const ACCOUNT_ERROR_CODES = new Set<unknown>([401, 402, 403, '401', '402', '403']);
const ACCOUNT_ERROR_TYPES = new Set<unknown>([
  'authentication_error',
  'permission_error',
  'billing_error',
  'invalid_api_key',
  'insufficient_quota',
  'billing_hard_limit_reached',
]);

type UpstreamStreamError = {
  message?: string | null;
  code?: number | string | null;
  type?: string | null;
  error_type?: string | null;
  metadata?: Record<string, unknown>;
};

function isAccountError(error: UpstreamStreamError): boolean {
  return (
    ACCOUNT_ERROR_CODES.has(error.code) ||
    ACCOUNT_ERROR_TYPES.has(error.code) ||
    ACCOUNT_ERROR_TYPES.has(error.type) ||
    ACCOUNT_ERROR_TYPES.has(error.error_type) ||
    ACCOUNT_ERROR_TYPES.has(error.metadata?.error_type)
  );
}

/**
 * Reports an error event received inside an upstream SSE stream. Transient
 * upstream failures (timeouts, overloads, dropped streams) are only logged, since
 * they are frequent and not actionable. Authentication, permission, and billing
 * failures on Kilo-owned credentials, including organization custom LLM keys,
 * are sent to Sentry, since Kilo's provider keys or upstream account need
 * attention. On user credentials (BYOK keys, ChatGPT subscriptions) they are
 * logged.
 */
export function reportUpstreamStreamError(params: {
  label: string;
  source: string;
  error: UpstreamStreamError;
  usesUserCredentials: boolean;
  logContext: Record<string, unknown>;
  sentryExtra: Record<string, unknown>;
}) {
  const { label, source, error, usesUserCredentials, logContext, sentryExtra } = params;
  const message = `${label}: ${error.message ?? 'unknown'}`;
  if (!usesUserCredentials && isAccountError(error)) {
    captureException(new Error(message), { tags: { source }, extra: sentryExtra });
    return;
  }
  console.warn(message, {
    source,
    code: error.code,
    error_type: error.error_type ?? error.metadata?.error_type ?? error.type,
    uses_user_credentials: usesUserCredentials,
    ...logContext,
  });
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
