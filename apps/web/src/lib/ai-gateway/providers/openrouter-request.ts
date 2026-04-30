import { debugSaveProxyResponseStream } from '../../debugUtils';
import { fetchWithBackoff } from '../../fetchWithBackoff';
import { captureException, captureMessage } from '@sentry/nextjs';
import type {
  GatewayResponsesRequest,
  OpenRouterChatCompletionRequest,
  OpenRouterGeneration,
  GatewayMessagesRequest,
} from '@/lib/ai-gateway/providers/openrouter/types';
import type { Provider } from '@/lib/ai-gateway/providers/types';

export async function openRouterRequest({
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
  // HTTP-Referer deviates from HTTP spec per https://openrouter.ai/docs/api-reference/overview#headers
  // Important: this must be the same as in the extension, so they're seen as the same app.
  // TODO: Don't change HTTP-Referer; per OpenRouter docs it would identify us as a different app
  headers.set('HTTP-Referer', 'https://kilocode.ai');
  headers.set('X-Title', 'Kilo Code');
  headers.set('Authorization', `Bearer ${provider.apiKey}`);

  headers.set('Content-Type', 'application/json');

  Object.entries(extraHeaders).forEach(([key, value]) => {
    headers.set(key, value);
  });

  const targetUrl = `${provider.apiUrl}${path}${search}`;

  const TEN_MINUTES_MS = 10 * 60 * 1000;
  const timeoutSignal = AbortSignal.timeout(TEN_MINUTES_MS);
  const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

  return await fetch(targetUrl, {
    method,
    headers,
    body: JSON.stringify(body),
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
          'HTTP-Referer': 'https://kilocode.ai',
          'X-Title': 'Kilo Code',
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
