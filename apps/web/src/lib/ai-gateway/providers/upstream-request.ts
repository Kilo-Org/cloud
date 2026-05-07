import { debugSaveProxyResponseStream } from '../../debugUtils';
import { fetchWithBackoff } from '../../fetchWithBackoff';
import { captureException, captureMessage } from '@sentry/nextjs';
import type {
  GatewayResponsesRequest,
  OpenRouterChatCompletionRequest,
  OpenRouterGeneration,
  GatewayMessagesRequest,
} from '@/lib/ai-gateway/providers/openrouter/types';
import { ATTRIBUTION_HEADERS } from '@/lib/ai-gateway/providers/openrouter/attribution-headers';
import type { Provider } from '@/lib/ai-gateway/providers/types';

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
  headers.set('Content-Type', 'application/json');

  Object.entries(extraHeaders).forEach(([key, value]) => {
    headers.set(key, value);
  });

  let targetUrl = `${provider.apiUrl}${path}${search}`;
  const serializedBody = JSON.stringify(body);

  if (provider.signRequest) {
    const signed = await provider.signRequest({
      method,
      url: targetUrl,
      body: serializedBody,
    });
    if (signed.url) targetUrl = signed.url;
    for (const [key, value] of Object.entries(signed.headers)) {
      headers.set(key, value);
    }
  } else if (provider.apiKey) {
    headers.set('Authorization', `Bearer ${provider.apiKey}`);
  }

  const TEN_MINUTES_MS = 10 * 60 * 1000;
  const timeoutSignal = AbortSignal.timeout(TEN_MINUTES_MS);
  const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

  return await fetch(targetUrl, {
    method,
    headers,
    body: serializedBody,
    // @ts-expect-error see https://github.com/node-fetch/node-fetch/issues/1769
    duplex: 'half',
    signal: combinedSignal,
  });
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
