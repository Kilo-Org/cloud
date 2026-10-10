import { debugSaveProxyResponseStream } from '../../debugUtils';
import { fetchWithBackoff } from '../../fetchWithBackoff';
import { captureException, captureMessage } from '@sentry/nextjs';
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
 * about 75s of backoff), then the usage-record call (`ATTEMPT_TIMEOUT_MS`, 90s),
 * then its local fallback write. By design that can need ~165s plus the
 * fallback, nearly all of the 200s this cap leaves. Production logs agree on the
 * typical case (after() done within 80s of a stream that ran this full cap), but
 * only the design bound covers a slow usage endpoint, so the cap is not raised:
 * a function killed at maxDuration loses its usage record.
 */
const UPSTREAM_DURATION_BUDGET_MS = 10 * 60 * 1000;

/**
 * Header wait for streaming requests only; it stops once the headers arrive, so
 * it never cuts a stream that is already flowing. Streaming responses are
 * observed to send headers within ~300s of the request (an upstream limit sits
 * just below that), so 360s leaves margin while failing a dead request 4 minutes
 * sooner. A non-streaming response sends its headers with the whole completion,
 * so only `UPSTREAM_DURATION_BUDGET_MS` bounds that wait.
 */
const STREAMING_HEADER_TIMEOUT_MS = 6 * 60 * 1000;

function formatSeconds(ms: number): string {
  return `${Number((ms / 1000).toFixed(1))}s`;
}

/**
 * Abort reason when the gateway's own limit stops an upstream call. Its name
 * stays `TimeoutError`, so failure classification is unchanged. It records
 * whether the response headers had arrived, so the logs and the client-visible
 * error can tell a header wait from a stream that outlived the duration budget.
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

// fetchWithBackoff reserves the next delay before retrying, so 75s yields about one minute.
const GENERATION_FETCH_MAX_DELAY_MS = 75 * 1000;
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
  if (provider.apiKeyHeader === 'x-api-key') {
    headers.set('x-api-key', provider.apiKey);
  } else {
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
  // AbortSignal.timeout keeps its timers unref'd; re-aborting through our own
  // controller lets the abort reason say which limit fired and in which phase.
  const timeoutController = new AbortController();
  const abortOnTimeout = (limitMs: number) => {
    const reason = new UpstreamTimeoutError(limitMs, headersReceivedAfterMs);
    errorExceptInTest(`[upstreamRequest] ${reason.message}`, {
      vercelRequestId: vercelRequestId ?? '<none>',
      phase: headersReceivedAfterMs === null ? 'headers' : 'stream',
    });
    timeoutController.abort(reason);
  };
  const budgetSignal = AbortSignal.timeout(UPSTREAM_DURATION_BUDGET_MS);
  const onBudgetExceeded = () => abortOnTimeout(UPSTREAM_DURATION_BUDGET_MS);
  budgetSignal.addEventListener('abort', onBudgetExceeded);
  const headerSignal =
    body.stream === true ? AbortSignal.timeout(STREAMING_HEADER_TIMEOUT_MS) : null;
  const onHeaderTimeout = () => abortOnTimeout(STREAMING_HEADER_TIMEOUT_MS);
  headerSignal?.addEventListener('abort', onHeaderTimeout);
  const stopHeaderTimeout = () => headerSignal?.removeEventListener('abort', onHeaderTimeout);
  after(() => {
    stopHeaderTimeout();
    budgetSignal.removeEventListener('abort', onBudgetExceeded);
  });
  const combinedSignal = signal
    ? AbortSignal.any([signal, timeoutController.signal])
    : timeoutController.signal;

  try {
    const targetUrl = provider.disableUrlSuffix
      ? appendQueryString(apiUrl, search)
      : `${apiUrl}${path}${search}`;

    const response = await fetch(targetUrl, {
      method,
      headers,
      body: JSON.stringify(body),
      // @ts-expect-error see https://github.com/node-fetch/node-fetch/issues/1769
      duplex: 'half',
      signal: combinedSignal,
    });
    headersReceivedAfterMs = performance.now() - fetchStartedAt;
    stopHeaderTimeout();
    return { type: 'success', response };
  } catch (error) {
    // No response body to bound; a later fallback attempt must not be blamed
    // for this attempt's timers.
    stopHeaderTimeout();
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
        providerId: provider.id,
        targetHost: getProviderTargetHost(apiUrl),
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
            provider: provider.id,
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

export async function fetchGeneration(messageId: string, provider: Provider) {
  // We have to delay, openrouter doesn't have the cost immediately
  await new Promise(res => setTimeout(res, 200));
  //ref: https://openrouter.ai/docs/api-reference/get-a-generation
  let response: Response;
  try {
    response = await fetchWithBackoff(
      `${provider.apiUrl}/generation?id=${messageId}`,
      {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${provider.apiKey}`,
          ...ATTRIBUTION_HEADERS,
        },
      },
      {
        baseDelayMs: 5_000,
        maxDelayMs: GENERATION_FETCH_MAX_DELAY_MS,
        retryResponse: r => r.status >= 400,
      }
    );
  } catch (error) {
    captureException(error, {
      level: 'info',
      tags: { source: `${provider.id}_generation_fetch` },
      extra: { messageId },
    });
    return;
  }

  if (!response.ok) {
    const responseText = await response.text();
    captureMessage(`Timed out fetching openrouter generation`, {
      level: 'info',
      tags: { source: `${provider.id}_generation_fetch` },
      extra: {
        messageId,
        status: response.status,
        statusText: response.statusText,
        responseText,
      },
    });
    return;
  }

  debugSaveProxyResponseStream(response, `-${messageId}.log.generation.json`);

  return (await response.json()) as OpenRouterGeneration;
}
