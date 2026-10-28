import { captureException, captureMessage } from '@sentry/nextjs';
import type { Span } from '@sentry/nextjs';
import { createParser, type EventSourceMessage } from 'eventsource-parser';
import { toMicrodollars } from '@kilocode/web-shared/lib/microdollars';
import { errorExceptInTest } from '@kilocode/web-shared/lib/utils.server';
import { OPENROUTER_BYOK_COST_MULTIPLIER } from '@kilocode/web-shared/lib/ai-gateway/processUsage.constants';
import type { ProviderId } from '@kilocode/web-shared/lib/ai-gateway/providers/types';
import type {
  JustTheCostsUsageStats,
  NotYetCostedUsageStats,
  VercelProviderAttempt,
  VercelProviderMetaData,
} from '@kilocode/web-shared/lib/ai-gateway/processUsage.types';

type OpenRouterCostFields = {
  cost?: number;
  is_byok?: boolean | null;
  cost_details?: { upstream_inference_cost?: number | null };
};

function byokFee_USD(provider: ProviderId, upstreamInferenceCost_USD: number) {
  return provider === 'vercel' ? 0 : upstreamInferenceCost_USD / OPENROUTER_BYOK_COST_MULTIPLIER;
}

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
 * On a BYOK request the provider bills inference to the key, and the gateway's
 * own `cost` is what it charged on top: server tools, plugins and PDF parsing,
 * plus OpenRouter's BYOK fee of 5% of the upstream cost. The fee is not passed
 * on. OpenRouter does not report it separately and waives it for the first
 * requests of a month, so these charges are undercharged by up to the fee then.
 * Vercel charges no fee.
 */
export function byokNonInferenceCost_mUsd(
  provider: ProviderId,
  gatewayCost_USD: number,
  upstreamInferenceCost_USD: number
): number {
  return Math.max(
    0,
    toMicrodollars(gatewayCost_USD - byokFee_USD(provider, upstreamInferenceCost_USD))
  );
}

/** The billed cost of OpenRouter-style usage cost fields, which Vercel also returns. */
export function computeOpenRouterCosts(
  usage: OpenRouterCostFields,
  provider: ProviderId
): Pick<JustTheCostsUsageStats, 'cost_mUsd' | 'nonInferenceCost_mUsd'> {
  const cost_USD = usage.cost ?? 0;
  if (!usage.is_byok) {
    return { cost_mUsd: toMicrodollars(cost_USD) };
  }
  const upstreamInferenceCost_USD = usage.cost_details?.upstream_inference_cost ?? 0;
  const nonInferenceCost_mUsd = byokNonInferenceCost_mUsd(
    provider,
    cost_USD,
    upstreamInferenceCost_USD
  );
  return {
    cost_mUsd: toMicrodollars(upstreamInferenceCost_USD) + nonInferenceCost_mUsd,
    nonInferenceCost_mUsd,
  };
}

/**
 * Computes the cost and BYOK status from OpenRouter-style usage cost fields,
 * which Vercel also returns, and emits a Sentry warning when the accounting
 * looks suspicious. A cost without a BYOK status cannot be trusted;
 * `requireIsByok` says whether that is suspicious for this response.
 */
export function computeOpenRouterCostFields(
  usage: OpenRouterCostFields,
  coreProps: NotYetCostedUsageStats,
  source: string,
  requireIsByok: boolean,
  provider: ProviderId
): Pick<JustTheCostsUsageStats, 'cost_mUsd' | 'nonInferenceCost_mUsd' | 'is_byok'> {
  const is_byok = usage.is_byok ?? null;
  const openrouterCost_USD = usage.cost ?? 0;
  const upstream_inference_cost_USD = usage.cost_details?.upstream_inference_cost ?? 0;
  const { cost_mUsd, nonInferenceCost_mUsd } = computeOpenRouterCosts(usage, provider);
  const fee_USD = byokFee_USD(provider, upstream_inference_cost_USD);
  if (
    (requireIsByok && is_byok == null && (openrouterCost_USD || upstream_inference_cost_USD)) || // unknown byok status but known non-zero costs? We're borked!
    // A BYOK charge is 0 while the fee is waived, and at least the fee otherwise.
    (is_byok && openrouterCost_USD > 0 && (fee_USD - openrouterCost_USD) * 1_000_000 > 1.1) ||
    // Without the upstream cost, a BYOK request bills no inference at all.
    (is_byok && openrouterCost_USD > 0 && usage.cost_details?.upstream_inference_cost == null)
  ) {
    const { responseContent: _ignore, ...corePropsCopy } = coreProps;
    captureMessage("SUSPICIOUS: openrouters cost accounting doesn't make sense", {
      level: 'error',
      tags: { source },
      extra: {
        ...corePropsCopy,
        provider,
        cost_mUsd,
        nonInferenceCost_mUsd,
        is_byok,
        openrouterCost_USD,
        upstream_inference_cost_USD,
        fee_USD,
      },
    });
  }
  return { cost_mUsd, nonInferenceCost_mUsd, is_byok };
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
): Pick<JustTheCostsUsageStats, 'cost_mUsd' | 'nonInferenceCost_mUsd'> {
  if (isByok && vercelGateway.marketCost != null) {
    const marketCost_USD = parseUsd(vercelGateway.marketCost);
    const nonInferenceCost_mUsd = byokNonInferenceCost_mUsd(
      'vercel',
      parseUsd(vercelGateway.cost),
      marketCost_USD
    );
    return {
      cost_mUsd: toMicrodollars(marketCost_USD) + nonInferenceCost_mUsd,
      nonInferenceCost_mUsd,
    };
  }
  return { cost_mUsd: toMicrodollars(parseUsd(vercelGateway.marketCost ?? vercelGateway.cost)) };
}

/**
 * Selects the cost source for a Messages or Responses usage payload: OpenRouter
 * `usage.cost`/`usage.is_byok` first, then Vercel `provider_metadata.gateway`
 * `marketCost`/`cost`, else zero cost with unknown BYOK status.
 */
export function selectUsageCostFields(
  usage: OpenRouterCostFields | null | undefined,
  providerMetadata: VercelProviderMetaData | null | undefined,
  coreProps: NotYetCostedUsageStats,
  source: string,
  provider: ProviderId
): Pick<JustTheCostsUsageStats, 'cost_mUsd' | 'nonInferenceCost_mUsd' | 'is_byok'> {
  if (usage?.cost != null || usage?.is_byok != null) {
    return computeOpenRouterCostFields(
      usage,
      coreProps,
      source,
      providerReportsIsByok(provider),
      provider
    );
  }

  const vercelGateway = providerMetadata?.gateway;
  if (vercelGateway?.marketCost != null || vercelGateway?.cost != null) {
    const is_byok = extractVercelIsByok(vercelGateway);
    return { ...computeVercelCostFields(vercelGateway, is_byok), is_byok };
  }

  return { cost_mUsd: 0, is_byok: null };
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

export type ResponseTiming = Pick<NotYetCostedUsageStats, 'latency' | 'generation_time'>;

/**
 * Records when the first and final chunks of an upstream response arrive. The
 * gateway measures this itself, rather than trusting upstream-reported timings,
 * so `latency` and `generation_time` mean the same thing for every provider:
 * - `latency`: from `requestStartedAt` (a `performance.now()` value) until the
 *   first chunk, or null when the start is unknown.
 * - `generation_time`: from the first chunk until the final chunk, so the two
 *   add up to the total response time.
 * Both are null when no chunk arrived.
 */
function createChunkTimer() {
  let firstChunkAt: number | null = null;
  let finalChunkAt: number | null = null;
  return {
    markChunk() {
      const now = performance.now();
      firstChunkAt ??= now;
      finalChunkAt = now;
    },
    receivedChunk: () => firstChunkAt !== null,
    timing(requestStartedAt: number | undefined): ResponseTiming {
      if (firstChunkAt === null || finalChunkAt === null) {
        return { latency: null, generation_time: null };
      }
      return {
        latency:
          requestStartedAt === undefined
            ? null
            : Math.max(0, Math.round(firstChunkAt - requestStartedAt)),
        generation_time: Math.round(finalChunkAt - firstChunkAt),
      };
    },
  };
}

const isWhitespace = (text: string) => text.trim() === '';

/**
 * Drains an SSE response body, calling `onEvent` for each parsed event. Handles
 * stream processing failures gracefully and always releases the reader lock and
 * ends `streamProcessingSpan`.
 *
 * Each SSE event is a chunk for the response timing, so keep-alive comments such
 * as OpenRouter's `: OPENROUTER PROCESSING` do not count as the first chunk. A
 * body without any event, such as a JSON error, is timed by its non-whitespace
 * chunks instead.
 *
 * `wasAborted` is `true` if the stream was aborted before completion.
 */
export async function drainSseStream(
  stream: ReadableStream<Uint8Array>,
  onEvent: (event: EventSourceMessage) => void,
  streamProcessingSpan: Span,
  requestStartedAt: number | undefined
): Promise<{ wasAborted: boolean; timing: ResponseTiming }> {
  const eventTimer = createChunkTimer();
  const chunkTimer = createChunkTimer();
  const sseStreamParser = createParser({
    onEvent(event) {
      eventTimer.markChunk();
      onEvent(event);
    },
  });
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let wasAborted = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const text = decoder.decode(value, { stream: true });
      if (!isWhitespace(text)) chunkTimer.markChunk();
      sseStreamParser.feed(text);
    }
  } catch (error) {
    errorExceptInTest('[processUsage] treating stream processing error as aborted', error);
    wasAborted = true;
  } finally {
    reader.releaseLock();
    streamProcessingSpan.end();
  }
  const timer = eventTimer.receivedChunk() ? eventTimer : chunkTimer;
  return { wasAborted, timing: timer.timing(requestStartedAt) };
}

/**
 * Reads a non-streamed response body as text, timing its non-whitespace chunks.
 * Rejects with the body's own error when the read fails.
 */
export async function readResponseText(
  stream: ReadableStream<Uint8Array>,
  requestStartedAt: number | undefined
): Promise<{ text: string; timing: ResponseTiming }> {
  const chunkTimer = createChunkTimer();
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      if (!isWhitespace(chunk)) chunkTimer.markChunk();
      text += chunk;
    }
    text += decoder.decode();
  } finally {
    reader.releaseLock();
  }
  return { text, timing: chunkTimer.timing(requestStartedAt) };
}
