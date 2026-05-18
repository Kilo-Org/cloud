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
import type { Provider } from '@/lib/ai-gateway/providers/types';

type UpstreamFetchFailureFamily =
  | 'request_timeout'
  | 'headers_timeout'
  | 'connect_timeout'
  | 'read_timeout'
  | 'conn_reset'
  | 'abort'
  | 'unknown';

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

export async function upstreamRequest({
  path,
  search,
  method,
  body,
  extraHeaders,
  provider,
  signal,
}: {
  path: string;
  search: string;
  method: string;
  body: OpenRouterChatCompletionRequest | GatewayResponsesRequest | GatewayMessagesRequest;
  extraHeaders: Record<string, string>;
  provider: Provider;
  signal?: AbortSignal;
}) {
  const headers = new Headers();
  for (const [key, value] of Object.entries(ATTRIBUTION_HEADERS)) {
    headers.set(key, value);
  }
  headers.set('Authorization', `Bearer ${provider.apiKey}`);
  headers.set('Content-Type', 'application/json');

  Object.entries(extraHeaders).forEach(([key, value]) => {
    headers.set(key, value);
  });

  const targetUrl = `${provider.apiUrl}${path}${search}`;

  const TEN_MINUTES_MS = 10 * 60 * 1000;
  const timeoutSignal = AbortSignal.timeout(TEN_MINUTES_MS);
  const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

  try {
    return await fetch(targetUrl, {
      method,
      headers,
      body: JSON.stringify(body),
      // @ts-expect-error see https://github.com/node-fetch/node-fetch/issues/1769
      duplex: 'half',
      signal: combinedSignal,
    });
  } catch (error) {
    try {
      const cause = error instanceof Error ? error.cause : undefined;
      const errorName = getErrorName(error);
      const errorMessage = getErrorMessage(error);
      const causeCode = getCauseCode(cause);
      const causeName = getCauseName(cause);
      const causeMessage = getCauseMessage(cause);
      const failureFamily = classifyUpstreamFetchFailure({ errorName, causeCode, causeName });
      const failureMetadata = {
        providerId: provider.id,
        targetHost: getProviderTargetHost(provider.apiUrl),
        path,
        failureFamily,
        errorName,
        errorMessage,
        ...(causeCode && { causeCode }),
        ...(causeName && { causeName }),
        ...(causeMessage && { causeMessage }),
      };

      if (!(failureFamily === 'abort' && signal?.aborted)) {
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

    throw error;
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
      { retryResponse: r => r.status >= 400 } // openrouter returns 404 when called too soon.
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
