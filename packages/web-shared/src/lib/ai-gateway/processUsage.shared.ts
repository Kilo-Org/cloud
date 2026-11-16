import { captureException, captureMessage } from '@sentry/nextjs';
import type { Span } from '@sentry/nextjs';
import { createParser, type EventSourceMessage } from 'eventsource-parser';
import { z } from 'zod';
import { toMicrodollars } from '@kilocode/web-shared/lib/microdollars';
import { errorExceptInTest } from '@kilocode/web-shared/lib/utils.server';
import { OPENROUTER_BYOK_COST_MULTIPLIER } from '@kilocode/web-shared/lib/ai-gateway/processUsage.constants';
import type { ProviderType } from '@kilocode/web-shared/lib/ai-gateway/providers/types';
import type {
  JustTheCostsUsageStats,
  MicrodollarUsageContext,
  MicrodollarUsageStats,
  NotYetCostedUsageStats,
  VercelProviderAttempt,
  VercelProviderMetaData,
} from '@kilocode/web-shared/lib/ai-gateway/processUsage.types';

export const vercelProviderMetadataSchema = z.looseObject({
  gateway: z
    .looseObject({
      cost: z.string().optional(),
      marketCost: z.string().optional(),
      routing: z
        .looseObject({
          canonicalSlug: z.string().optional(),
          finalProvider: z.string().optional(),
          modelAttempts: z
            .array(
              z.looseObject({
                canonicalSlug: z.string().optional(),
                success: z.boolean().optional(),
                providerAttempts: z
                  .array(
                    z.looseObject({
                      provider: z.string().optional(),
                      credentialType: z.string().optional(),
                      success: z.boolean().optional(),
                      providerRequestId: z.string().optional(),
                      providerResponseId: z.string().optional(),
                    })
                  )
                  .optional(),
              })
            )
            .optional(),
        })
        .optional(),
    })
    .optional(),
});

export const usageCostSchema = z.object({
  cost: z.number().nullish(),
  is_byok: z.boolean().nullish(),
  cost_details: z.object({ upstream_inference_cost: z.number().nullish() }).nullish(),
});

/** A typed content part, such as a text block or delta, whose `textType` parts must carry text. */
export function contentPartSchema(textType: string) {
  return z
    .looseObject({ type: z.string(), text: z.string().optional() })
    .refine(part => part.type !== textType || part.text !== undefined);
}

export const upstreamStreamErrorSchema = z.object({
  message: z.string().nullish(),
  code: z.union([z.number(), z.string()]).nullish(),
  type: z.string().nullish(),
  error_type: z.string().nullish(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const openRouterUsageSchema = usageCostSchema.extend({
  prompt_tokens: z.number().nullish(),
  completion_tokens: z.number().nullish(),
  prompt_tokens_details: z
    .object({
      cached_tokens: z.number().nullish(),
      cache_write_tokens: z.number().nullish(),
      cache_creation_input_tokens: z.number().nullish(),
    })
    .nullish(),
});

type OpenRouterCostFields = {
  cost?: number | null;
  is_byok?: boolean | null;
  cost_details?: { upstream_inference_cost?: number | null } | null;
};

function byokFee_USD(provider: ProviderType, upstreamInferenceCost_USD: number) {
  return provider === 'vercel' ? 0 : upstreamInferenceCost_USD / OPENROUTER_BYOK_COST_MULTIPLIER;
}

/**
 * Whether the provider reports `usage.is_byok` next to `usage.cost`. OpenRouter
 * does on chat completions, Messages, Responses and embeddings, and Vercel AI
 * Gateway does on chat completions.
 */
export function providerReportsIsByok(provider: ProviderType): boolean {
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
  provider: ProviderType,
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
  provider: ProviderType
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
  provider: ProviderType
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
  provider: ProviderType
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

/** A body read that stopped because the client left, a timeout fired, or the upstream connection broke. */
export function isResponseInterruptedError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('name' in error)) return false;
  return (
    error.name === 'AbortError' ||
    error.name === 'ResponseAborted' ||
    error.name === 'TimeoutError' ||
    getUpstreamBodyTermination(error) !== null
  );
}

/**
 * The longest model name that an error report keeps. A requested model comes
 * from the client request, so a report bounds it instead of trusting it.
 */
export const REPORTED_MODEL_MAX_LENGTH = 200;

/**
 * The usage-context fields that an error report may carry. `Pick` narrows the
 * return type, so a context field added later is not attached by default. The
 * report must not throw, so a missing requested model becomes null and a
 * missing usage id becomes null.
 *
 * The report keeps the two server-derived ids that relate it to a request: the
 * account id, as the sibling usage reports do, and the usage id, which the
 * request log lines also carry. The requested model comes from the client
 * request, so the report bounds its length.
 */
export function usageContextReportFields(usageContext: MicrodollarUsageContext): Pick<
  MicrodollarUsageContext,
  'kiloUserId' | 'provider' | 'api_kind' | 'isStreaming'
> & {
  usageId: string | null;
  requested_model: string | null;
  status_code: MicrodollarUsageContext['status_code'];
} {
  const requestedModel: unknown = usageContext.requested_model;
  return {
    kiloUserId: usageContext.kiloUserId,
    usageId: usageContext.usageId ?? null,
    provider: usageContext.provider,
    api_kind: usageContext.api_kind,
    requested_model:
      typeof requestedModel === 'string'
        ? requestedModel.slice(0, REPORTED_MODEL_MAX_LENGTH)
        : null,
    status_code: usageContext.status_code,
    isStreaming: usageContext.isStreaming,
  };
}

/**
 * Identifies why usage could not be read without the error message, which for
 * `JSON.parse` quotes the upstream body.
 */
function describeUsageReadError(error: unknown) {
  if (error instanceof z.ZodError) {
    return {
      errorName: 'ZodError',
      issues: error.issues.map(issue => ({
        path: issue.path.map(String).join('.'),
        code: issue.code,
      })),
    };
  }
  // Duck-typed because undici's body errors may come from another realm.
  const hasName =
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    typeof error.name === 'string';
  return { errorName: hasName ? error.name : typeof error };
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

export async function parseUsageWithRecovery(
  response: Response,
  context: MicrodollarUsageContext,
  parse: () => MicrodollarUsageStats | null | Promise<MicrodollarUsageStats | null>
): Promise<MicrodollarUsageStats> {
  try {
    const stats = await parse();
    if (!stats) throw new Error('Missing usage response body');
    stats.messageId ??= response.headers.get('x-generation-id');
    return stats;
  } catch (error) {
    const messageId = response.headers.get('x-generation-id');
    if (!isResponseInterruptedError(error)) {
      captureException(new Error('Unable to read or parse upstream usage response'), {
        tags: { source: 'usage_response_parsing', api_kind: context.api_kind },
        extra: {
          usageId: context.usageId,
          kiloUserId: context.kiloUserId,
          organizationId: context.organizationId,
          provider: context.provider,
          messageId,
          ...describeUsageReadError(error),
        },
      });
    }
    const contentType = response.headers.get('content-type');
    return {
      messageId,
      model: null,
      responseContent: '',
      hasError: true,
      inference_provider: null,
      upstream_id: null,
      finish_reason: null,
      latency: null,
      moderation_latency: null,
      generation_time: null,
      streamed: contentType?.includes('application/json')
        ? false
        : contentType?.includes('text/event-stream') || context.isStreaming,
      cancelled: null,
      status_code: response.status,
      cost_mUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheWriteTokens: 0,
      cacheHitTokens: 0,
      is_byok: null,
    };
  }
}

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
 * stream processing failures gracefully and always cleans up the reader and
 * ends `streamProcessingSpan`.
 *
 * Each SSE event is a chunk for the response timing, so keep-alive comments such
 * as OpenRouter's `: OPENROUTER PROCESSING` do not count as the first chunk. A
 * body without any event, such as a JSON error, is timed by its non-whitespace
 * chunks instead.
 *
 * Malformed events are skipped so later events can still supply usage.
 */
export async function drainSseStream(
  stream: ReadableStream<Uint8Array>,
  onEvent: (event: EventSourceMessage) => void,
  streamProcessingSpan: Span,
  requestStartedAt: number | undefined,
  getIds?: () => Record<string, string | null | undefined>
): Promise<{ wasAborted: boolean; malformedEventCount: number; timing: ResponseTiming }> {
  const eventTimer = createChunkTimer();
  const chunkTimer = createChunkTimer();
  let malformedEventCount = 0;
  let firstMalformedEventError: unknown;
  const sseStreamParser = createParser({
    onEvent(event) {
      eventTimer.markChunk();
      try {
        onEvent(event);
      } catch (error) {
        if (malformedEventCount === 0) firstMalformedEventError = error;
        malformedEventCount++;
      }
    },
  });
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let wasAborted = false;
  let reachedEof = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        reachedEof = true;
        break;
      }
      const text = decoder.decode(value, { stream: true });
      if (!isWhitespace(text)) chunkTimer.markChunk();
      sseStreamParser.feed(text);
    }
  } catch (error) {
    errorExceptInTest('[processUsage] treating stream processing error as aborted', error);
    wasAborted = true;
    if (!isResponseInterruptedError(error)) {
      captureException(new Error('Unable to read upstream usage stream'), {
        tags: { source: 'usage_stream_parsing' },
        extra: { ...getIds?.(), ...describeUsageReadError(error) },
      });
    }
  } finally {
    if (!reachedEof) {
      // A tee's cancellation waits for its sibling; accounting must not wait for it.
      void reader.cancel().catch(() => undefined);
    }
    reader.releaseLock();
    streamProcessingSpan.end();
  }
  if (malformedEventCount > 0) {
    captureMessage('Malformed upstream usage SSE events', {
      level: 'error',
      tags: { source: 'usage_stream_parsing' },
      extra: {
        ...getIds?.(),
        malformedEventCount,
        ...describeUsageReadError(firstMalformedEventError),
      },
    });
  }
  const timer = eventTimer.receivedChunk() ? eventTimer : chunkTimer;
  return { wasAborted, malformedEventCount, timing: timer.timing(requestStartedAt) };
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
