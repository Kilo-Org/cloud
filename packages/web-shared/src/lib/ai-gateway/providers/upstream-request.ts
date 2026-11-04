import { captureException, captureMessage } from '@sentry/nextjs';
import { isNativeError } from 'node:util/types';
import { z } from 'zod';
import { errorExceptInTest } from '@kilocode/web-shared/lib/utils.server';
import type {
  GatewayResponsesRequest,
  OpenRouterChatCompletionRequest,
  OpenRouterGeneration,
  GatewayMessagesRequest,
} from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/types';
import { ATTRIBUTION_HEADERS } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/attribution-headers';
import { getReasoningEffortTimeoutSuggestion } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/request-helpers';
import type {
  GatewayChatApiKind,
  Provider,
} from '@kilocode/web-shared/lib/ai-gateway/providers/types';
import { after, NextResponse } from 'next/server';
import { ProxyErrorType } from '@kilocode/web-shared/lib/proxy-error-types';
import { withRequestId } from '@kilocode/web-shared/lib/ai-gateway/request-id';
import { buildSecureProxyRequest } from '@kilocode/web-shared/lib/ai-gateway/providers/secure-proxy';
import { signBedrockRequest } from '@kilocode/web-shared/lib/ai-gateway/providers/aws-bedrock-signing';
import type { CustomLlmAwsBedrockCredentials } from '@kilocode/db/schema-types';
import {
  isUpstreamUrlPolicyEnforced,
  rejectDisallowedUpstreamUrls,
  rejectUpstreamRedirect,
} from '@kilocode/web-shared/lib/ai-gateway/providers/upstream-url-policy';

type UpstreamFetchFailureFamily =
  | 'request_timeout'
  | 'headers_timeout'
  | 'connect_timeout'
  | 'read_timeout'
  | 'conn_reset'
  | 'abort'
  | 'unknown';

/**
 * Hard cap on one upstream call, from the fetch through the last body byte; the
 * abort stays armed while the response streams.
 *
 * The gateway route's `maxDuration` of 800s covers the whole invocation,
 * including the `after()` work that starts once the stream ends. That work runs
 * in sequence in `countAndStoreUsage`: the generation lookup (`fetchGeneration`,
 * at most 75s including retries and body), then the usage-record call (`ATTEMPT_TIMEOUT_MS`, 90s),
 * then its local fallback write. By design that can need ~165s plus the
 * fallback, nearly all of the 200s this cap leaves. Production logs agree on the
 * typical case (after() done within 80s of a stream that ran this full cap), but
 * only the design bound covers a slow usage endpoint, so the cap is not raised:
 * a function killed at maxDuration loses its usage record.
 *
 * There is no separate header timer here: Node's fetch (undici) already fails a
 * header wait after 300s (`headersTimeout`, surfaced as UND_ERR_HEADERS_TIMEOUT
 * and classified `headers_timeout`), and that limit stops once headers arrive.
 */
const UPSTREAM_DURATION_BUDGET_MS = 10 * 60 * 1000;

function formatSeconds(ms: number): string {
  return `${Number((ms / 1000).toFixed(1))}s`;
}

/**
 * Abort reason when `UPSTREAM_DURATION_BUDGET_MS` stops an upstream call. Its
 * name stays `TimeoutError`, so failure classification is unchanged. It records
 * whether the response headers had arrived, so the logs and the client-visible
 * error can tell a header wait from a stream that outlived the budget.
 */
export class UpstreamTimeoutError extends Error {
  override readonly name = 'TimeoutError';
  readonly limitMs: number;
  /** Time from the upstream fetch to its response headers; null if they never arrived. */
  readonly headersReceivedAfterMs: number | null;

  constructor(limitMs: number, headersReceivedAfterMs: number | null) {
    super(
      headersReceivedAfterMs === null
        ? `gateway timeout after ${limitMs}ms waiting for upstream response headers`
        : `upstream stream exceeded the gateway duration budget after ${formatSeconds(limitMs)} (headers at ${formatSeconds(headersReceivedAfterMs)})`
    );
    this.limitMs = limitMs;
    this.headersReceivedAfterMs = headersReceivedAfterMs;
  }
}

const GENERATION_LOOKUP_BUDGET_MS = 75_000;
const GENERATION_ATTEMPT_TIMEOUT_MS = 10_000;
const GenerationSchema = z.object({
  data: z.object({
    id: z.string().min(1),
    is_byok: z.boolean().nullish(),
    total_cost: z.number().finite(),
    upstream_inference_cost: z.number().finite().nullish(),
    created_at: z.string(),
    model: z.string().min(1),
    // Vercel omits OpenRouter's origin metadata.
    origin: z.string().default(''),
    usage: z.number().finite(),
    upstream_id: z.string().nullish(),
    cache_discount: z.number().finite().nullish(),
    app_id: z.number().finite().nullish(),
    streamed: z.boolean().nullish(),
    cancelled: z.boolean().nullish(),
    provider_name: z.string().nullish(),
    latency: z.number().finite().nullish(),
    moderation_latency: z.number().finite().nullish(),
    generation_time: z.number().finite().nullish(),
    finish_reason: z.string().nullish(),
    native_finish_reason: z.string().nullish(),
    tokens_prompt: z.number().finite().nullish(),
    tokens_completion: z.number().finite().nullish(),
    native_tokens_prompt: z.number().finite().nullish(),
    native_tokens_completion: z.number().finite().nullish(),
    native_tokens_reasoning: z.number().finite().nullish(),
    native_tokens_cached: z.number().finite().nullish(),
    native_tokens_cache_creation: z.number().finite().nullish(),
    num_media_prompt: z.number().finite().nullish(),
    num_media_completion: z.number().finite().nullish(),
    num_search_results: z.number().finite().nullish(),
  }),
}) satisfies z.ZodType<OpenRouterGeneration>;
const CHAT_API_PATHS = {
  chat_completions: '/chat/completions',
  responses: '/responses',
  messages: '/messages',
} as const satisfies Record<GatewayChatApiKind, string>;

function appendQueryString(apiUrl: string, search: string): string {
  if (!search) return apiUrl;

  const url = new URL(apiUrl);
  const query = `${url.search}${url.search ? '&' : '?'}${search.slice(1)}`;
  return new URL(`${query}${url.hash}`, url).toString();
}

function getProviderTargetHost(apiUrl: string): string {
  try {
    return new URL(apiUrl).host;
  } catch {
    return 'invalid_provider_api_url';
  }
}

function getErrorName(error: unknown): string {
  if (error instanceof Error) return error.name;
  if (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    typeof error.name === 'string'
  ) {
    return error.name;
  }
  return 'UnknownError';
}

function redactUrlsFromErrorMessage(message: string): string {
  return message.replace(/https?:\/\/[^\s)]+/g, '[redacted-url]');
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return redactUrlsFromErrorMessage(error.message);
  if (
    typeof error === 'object' &&
    error !== null &&
    'message' in error &&
    typeof error.message === 'string'
  ) {
    return redactUrlsFromErrorMessage(error.message);
  }
  return 'Unknown upstream fetch error';
}

function getCauseCode(cause: unknown): string | undefined {
  if (
    typeof cause === 'object' &&
    cause !== null &&
    'code' in cause &&
    (typeof cause.code === 'string' || typeof cause.code === 'number')
  ) {
    return String(cause.code);
  }
  return undefined;
}

function getCauseName(cause: unknown): string | undefined {
  if (cause instanceof Error) return cause.name;
  if (
    typeof cause === 'object' &&
    cause !== null &&
    'name' in cause &&
    typeof cause.name === 'string'
  ) {
    return cause.name;
  }
  return undefined;
}

function getCauseMessage(cause: unknown): string | undefined {
  if (cause instanceof Error) return redactUrlsFromErrorMessage(cause.message);
  if (
    typeof cause === 'object' &&
    cause !== null &&
    'message' in cause &&
    typeof cause.message === 'string'
  ) {
    return redactUrlsFromErrorMessage(cause.message);
  }
  return undefined;
}

function createLoggedFetchFailure(errorName: string, errorMessage: string): Error {
  const loggedError = new Error(errorMessage);
  loggedError.name = errorName;
  return loggedError;
}

function classifyUpstreamFetchFailure({
  errorName,
  causeCode,
  causeName,
}: {
  errorName: string;
  causeCode: string | undefined;
  causeName: string | undefined;
}): UpstreamFetchFailureFamily {
  if (errorName === 'TimeoutError' || causeName === 'TimeoutError') {
    return 'request_timeout';
  }

  if (errorName === 'AbortError' || causeName === 'AbortError' || causeCode === 'ABORT_ERR') {
    return 'abort';
  }

  switch (causeCode) {
    case 'UND_ERR_HEADERS_TIMEOUT':
      return 'headers_timeout';
    case 'UND_ERR_CONNECT_TIMEOUT':
      return 'connect_timeout';
    case 'UND_ERR_BODY_TIMEOUT':
    case 'ETIMEDOUT':
      return 'read_timeout';
    case 'ECONNRESET':
      return 'conn_reset';
    default:
      return 'unknown';
  }
}

/**
 * The client going away also aborts our upstream fetch, so the abort has to be
 * attributed to the client rather than reported as an upstream fault. The body
 * is mostly for logs and observability: the client that would read it is gone.
 * 499 mirrors the nginx convention so these cancellations do not show up as
 * upstream 5xx failures.
 */
function clientDisconnectResponse(vercelRequestId: string | null | undefined) {
  const error = withRequestId(
    'The client disconnected before the upstream provider responded, so the request was cancelled. The upstream provider did not fail.',
    vercelRequestId
  );
  return NextResponse.json(
    {
      error,
      error_type: ProxyErrorType.client_disconnect,
      message: error,
      ...(vercelRequestId && { vercel_request_id: vercelRequestId }),
    },
    { status: 499 }
  );
}

function upstreamFetchFailureResponse(
  failureFamily: UpstreamFetchFailureFamily,
  vercelRequestId: string | null | undefined,
  reasoningEffort: string | null
) {
  const error = withRequestId(
    failureFamily === 'request_timeout' ||
      failureFamily === 'headers_timeout' ||
      failureFamily === 'connect_timeout' ||
      failureFamily === 'read_timeout'
      ? `The upstream provider did not send response headers before the gateway timeout.${getReasoningEffortTimeoutSuggestion(reasoningEffort)}`
      : 'The upstream provider closed the connection before sending a response.',
    vercelRequestId
  );
  return NextResponse.json(
    {
      error,
      error_type: ProxyErrorType.upstream_disconnect,
      message: error,
      ...(vercelRequestId && { vercel_request_id: vercelRequestId }),
    },
    { status: 503 }
  );
}

async function buildSignedBedrockRequest({
  url,
  method,
  headers,
  body,
  credentials,
}: {
  url: string;
  method: string;
  headers: Headers;
  body: OpenRouterChatCompletionRequest | GatewayResponsesRequest | GatewayMessagesRequest;
  credentials: CustomLlmAwsBedrockCredentials;
}) {
  const serializedBody = JSON.stringify(body);
  return {
    url,
    headers: await signBedrockRequest({
      url,
      method,
      headers,
      body: serializedBody,
      credentials,
    }),
    body: serializedBody,
  };
}

export async function upstreamRequest({
  chatApi,
  search,
  method,
  body,
  extraHeaders,
  provider,
  signal,
  vercelRequestId,
  reasoningEffort,
}: {
  chatApi: GatewayChatApiKind;
  search: string;
  method: string;
  body: OpenRouterChatCompletionRequest | GatewayResponsesRequest | GatewayMessagesRequest;
  extraHeaders: Record<string, string>;
  provider: Provider;
  signal?: AbortSignal;
  /** Incoming `x-vercel-id`, used to correlate failures with the platform logs. */
  vercelRequestId?: string | null;
  reasoningEffort: string | null;
}): Promise<{ type: 'success'; response: Response } | { type: 'error'; response: NextResponse }> {
  const headers = new Headers();
  for (const [key, value] of Object.entries(ATTRIBUTION_HEADERS)) {
    headers.set(key, value);
  }
  if (provider.secureProxy) {
    for (const [key, value] of Object.entries(provider.secureProxy.upstreamAuthHeaders)) {
      headers.set(key, value);
    }
  } else if (provider.apiKeyHeader === 'x-api-key') {
    headers.set('x-api-key', provider.apiKey);
  } else if (!provider.awsBedrock) {
    headers.set('Authorization', `Bearer ${provider.apiKey}`);
  }
  headers.set('Content-Type', 'application/json');

  Object.entries(extraHeaders).forEach(([key, value]) => {
    headers.set(key, value);
  });

  const apiUrl = provider.apiUrlOverrides[chatApi] ?? provider.apiUrl;
  const path = provider.disableUrlSuffix ? '' : CHAT_API_PATHS[chatApi];

  const fetchStartedAt = performance.now();
  let headersReceivedAfterMs: number | null = null;
  // AbortSignal.timeout keeps its timer unref'd; re-aborting through our own
  // controller lets the abort reason say which phase the budget ran out in.
  const timeoutController = new AbortController();
  const budgetSignal = AbortSignal.timeout(UPSTREAM_DURATION_BUDGET_MS);
  const onBudgetExceeded = () => {
    const reason = new UpstreamTimeoutError(UPSTREAM_DURATION_BUDGET_MS, headersReceivedAfterMs);
    errorExceptInTest(`[upstreamRequest] ${reason.message}`, {
      vercelRequestId: vercelRequestId ?? '<none>',
      phase: headersReceivedAfterMs === null ? 'headers' : 'stream',
    });
    timeoutController.abort(reason);
  };
  budgetSignal.addEventListener('abort', onBudgetExceeded);
  after(() => {
    budgetSignal.removeEventListener('abort', onBudgetExceeded);
  });
  const combinedSignal = signal
    ? AbortSignal.any([signal, timeoutController.signal])
    : timeoutController.signal;

  try {
    const targetUrl = provider.disableUrlSuffix
      ? appendQueryString(apiUrl, search)
      : `${apiUrl}${path}${search}`;

    const outgoing = provider.secureProxy
      ? buildSecureProxyRequest({
          proxyUrl: provider.secureProxy.url,
          secret: provider.apiKey,
          upstreamUrl: targetUrl,
          upstreamHeaders: headers,
          body,
        })
      : provider.awsBedrock
        ? await buildSignedBedrockRequest({
            url: targetUrl,
            method,
            headers,
            body,
            credentials: provider.awsBedrock,
          })
        : { url: targetUrl, headers, body: JSON.stringify(body) };

    // SSRF guard: see upstream-url-policy.ts. The secure proxy fetches the
    // upstream URL from the relay body, so both hops are checked.
    const enforceUrlPolicy = isUpstreamUrlPolicyEnforced();
    const urlRejection = enforceUrlPolicy
      ? await rejectDisallowedUpstreamUrls({
          urls: provider.secureProxy ? [outgoing.url, targetUrl] : [outgoing.url],
          providerId: provider.type,
          vercelRequestId,
          signal: combinedSignal,
        })
      : null;
    if (urlRejection) {
      budgetSignal.removeEventListener('abort', onBudgetExceeded);
      return { type: 'error', response: urlRejection };
    }

    const response = await fetch(outgoing.url, {
      method,
      headers: outgoing.headers,
      body: outgoing.body,
      redirect: enforceUrlPolicy ? 'manual' : 'follow',
      // @ts-expect-error see https://github.com/node-fetch/node-fetch/issues/1769
      duplex: 'half',
      signal: combinedSignal,
    });
    headersReceivedAfterMs = performance.now() - fetchStartedAt;
    const redirectRejection = enforceUrlPolicy
      ? await rejectUpstreamRedirect({
          response,
          url: outgoing.url,
          providerId: provider.type,
          vercelRequestId,
        })
      : null;
    if (redirectRejection) {
      budgetSignal.removeEventListener('abort', onBudgetExceeded);
      return { type: 'error', response: redirectRejection };
    }
    return { type: 'success', response };
  } catch (error) {
    // No response body to bound; a later fallback attempt must not be blamed
    // for this attempt's budget.
    budgetSignal.removeEventListener('abort', onBudgetExceeded);
    // The caller passes the incoming request signal, so a client that goes away
    // aborts this fetch as well. Those aborts are client-side cancellations and
    // must not be reported (or alerted on) as upstream failures.
    const clientDisconnected = signal?.aborted === true;
    // Stays `undefined` when diagnostic enrichment below throws before classifying.
    let failureFamily: UpstreamFetchFailureFamily | undefined;
    try {
      const cause = error instanceof Error ? error.cause : undefined;
      const errorName = getErrorName(error);
      const errorMessage = getErrorMessage(error);
      const causeCode = getCauseCode(cause);
      const causeName = getCauseName(cause);
      const causeMessage = getCauseMessage(cause);
      failureFamily = classifyUpstreamFetchFailure({ errorName, causeCode, causeName });
      const failureMetadata = {
        providerId: provider.type,
        targetHost: getProviderTargetHost(apiUrl),
        ...(provider.secureProxy && {
          secureProxyHost: getProviderTargetHost(provider.secureProxy.url),
        }),
        path,
        failureFamily,
        errorName,
        errorMessage,
        ...(vercelRequestId && { vercelRequestId }),
        ...(causeCode && { causeCode }),
        ...(causeName && { causeName }),
        ...(causeMessage && { causeMessage }),
      };

      if (!(failureFamily === 'abort' && clientDisconnected)) {
        errorExceptInTest('AI gateway upstream fetch failed', failureMetadata);
        captureException(createLoggedFetchFailure(errorName, errorMessage), {
          level: 'error',
          tags: {
            source: 'ai-gateway-upstream-fetch',
            provider: provider.type,
            failure_family: failureFamily,
          },
          extra: failureMetadata,
        });
      }
    } catch {
      // Fetch failure must remain caller-visible even when diagnostic enrichment fails.
    }

    const causedByClientDisconnect =
      clientDisconnected && (failureFamily === 'abort' || failureFamily === undefined);

    return {
      type: 'error',
      response: causedByClientDisconnect
        ? clientDisconnectResponse(vercelRequestId)
        : upstreamFetchFailureResponse(
            failureFamily ?? 'unknown',
            vercelRequestId,
            reasoningEffort
          ),
    };
  }
}

export async function fetchGeneration(
  messageId: string,
  provider: Provider
): Promise<OpenRouterGeneration | undefined> {
  const startedAt = performance.now();
  // Generation costs are ingested asynchronously by the provider.
  await new Promise(res => setTimeout(res, 200));
  let nextDelayMs = 5_000 * (1 + (Math.random() - 0.5) / 10);
  let reason = 'budget_exhausted';
  let status: number | undefined;

  while (true) {
    const remainingMs = Math.floor(GENERATION_LOOKUP_BUDGET_MS - (performance.now() - startedAt));
    if (remainingMs <= 0) break;
    const signal = AbortSignal.timeout(Math.min(GENERATION_ATTEMPT_TIMEOUT_MS, remainingMs));
    try {
      reason = 'request_failed';
      status = undefined;
      const response = await fetch(
        `${provider.apiUrl}/generation?id=${encodeURIComponent(messageId)}`,
        {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${provider.apiKey}`,
            ...ATTRIBUTION_HEADERS,
          },
          signal,
        }
      );
      status = response.status;
      if (response.ok) {
        reason = 'body_read_failed';
        const payload: unknown = await response.json();
        const generation = GenerationSchema.safeParse(payload);
        if (generation.success) return generation.data;
        reason = 'invalid_payload';
        break;
      }
      reason = 'http_error';
      await response.body?.cancel();
    } catch (error) {
      if (isNativeError(error) && error.name === 'SyntaxError') {
        reason = 'invalid_json';
        break;
      }
      if (signal.aborted) reason = 'request_timeout';
    }

    if (performance.now() - startedAt + nextDelayMs >= GENERATION_LOOKUP_BUDGET_MS) break;
    await new Promise(res => setTimeout(res, nextDelayMs));
    nextDelayMs *= 1.5;
  }

  captureMessage('Generation lookup failed', {
    level: 'info',
    tags: { source: `${provider.type}_generation_fetch` },
    extra: { messageId, reason, status },
  });
  return undefined;
}
