import { debugSaveProxyResponseStream } from '../../debugUtils';
import { fetchWithBackoff } from '../../fetchWithBackoff';
import { captureException, captureMessage } from '@sentry/nextjs';
import { errorExceptInTest } from '@/lib/utils.server';
import type {
  GatewayResponsesRequest,
  OpenRouterChatCompletionRequest,
  OpenRouterGeneration,
  GatewayMessagesRequest,
} from '@/lib/ai-gateway/providers/openrouter/types';
import { ATTRIBUTION_HEADERS } from '@/lib/ai-gateway/providers/openrouter/attribution-headers';
import type { GatewayChatApiKind, Provider } from '@/lib/ai-gateway/providers/types';
import { after, NextResponse } from 'next/server';
import { ProxyErrorType } from '@/lib/proxy-error-types';
import { withRequestId } from '@/lib/ai-gateway/request-id';

type UpstreamFetchFailureFamily =
  | 'request_timeout'
  | 'headers_timeout'
  | 'connect_timeout'
  | 'read_timeout'
  | 'conn_reset'
  | 'abort'
  | 'unknown';

// Leave 200s of the Vercel function budget for post-stream work.
const TIMEOUT_MS = 10 * 60 * 1000;
// fetchWithBackoff reserves the next delay before retrying, so 75s yields about one minute.
const GENERATION_FETCH_MAX_DELAY_MS = 75 * 1000;
const CHAT_API_PATHS = {
  chat_completions: '/chat/completions',
  responses: '/responses',
  messages: '/messages',
} as const satisfies Record<GatewayChatApiKind, string>;

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
  vercelRequestId: string | null | undefined
) {
  const error = withRequestId(
    failureFamily === 'request_timeout' ||
      failureFamily === 'headers_timeout' ||
      failureFamily === 'connect_timeout' ||
      failureFamily === 'read_timeout'
      ? 'The upstream provider did not send response headers before the gateway timeout.'
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
  const path = CHAT_API_PATHS[chatApi];
  const targetUrl = `${apiUrl}${path}${search}`;

  const timeoutSignal = provider.disableRequestTimeout ? null : AbortSignal.timeout(TIMEOUT_MS);
  const onTimeoutAbort = () => {
    errorExceptInTest(
      `[upstreamRequest] gateway timeout after ${TIMEOUT_MS}ms waiting for upstream response headers`,
      { vercelRequestId: vercelRequestId ?? '<none>' }
    );
  };
  if (timeoutSignal) {
    timeoutSignal.addEventListener('abort', onTimeoutAbort);
    after(() => {
      timeoutSignal.removeEventListener('abort', onTimeoutAbort);
    });
  }
  const combinedSignal = timeoutSignal
    ? signal
      ? AbortSignal.any([signal, timeoutSignal])
      : timeoutSignal
    : signal;

  try {
    return {
      type: 'success',
      response: await fetch(targetUrl, {
        method,
        headers,
        body: JSON.stringify(body),
        // @ts-expect-error see https://github.com/node-fetch/node-fetch/issues/1769
        duplex: 'half',
        signal: combinedSignal,
      }),
    };
  } catch (error) {
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
        : upstreamFetchFailureResponse(failureFamily ?? 'unknown', vercelRequestId),
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
