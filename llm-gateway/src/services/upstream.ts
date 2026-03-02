import type { OpenRouterChatCompletionRequest, Provider } from '@kilocode/llm-shared';

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
  body: OpenRouterChatCompletionRequest;
  extraHeaders: Record<string, string>;
  provider: Provider;
  signal?: AbortSignal;
}): Promise<Response> {
  const headers = new Headers();
  headers.set('HTTP-Referer', 'https://kilocode.ai');
  headers.set('X-Title', 'Kilo Code');
  headers.set('Authorization', `Bearer ${provider.apiKey}`);
  headers.set('Content-Type', 'application/json');

  for (const [key, value] of Object.entries(extraHeaders)) {
    headers.set(key, value);
  }

  const targetUrl = `${provider.apiUrl}${path}${search}`;

  const TEN_MINUTES_MS = 10 * 60 * 1000;
  const timeoutSignal = AbortSignal.timeout(TEN_MINUTES_MS);
  const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

  return await fetch(targetUrl, {
    method,
    headers,
    body: JSON.stringify(body),
    // @ts-expect-error duplex needed for streaming request bodies
    duplex: 'half',
    signal: combinedSignal,
  });
}
