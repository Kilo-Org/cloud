export type JsonResponseInit = ResponseInit & {
  headers?: HeadersInit;
};

export function jsonResponse(body: unknown, init: JsonResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  if (!headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }
  return new Response(JSON.stringify(body), { ...init, headers });
}

export function getSafeProxyOutputHeaders(response: Response): Headers {
  const outputHeaders = new Headers();

  for (const headerKey of ['date', 'content-type', 'request-id']) {
    const value = response.headers.get(headerKey);
    if (value) outputHeaders.set(headerKey, value);
  }
  outputHeaders.set('Content-Encoding', 'identity');

  return outputHeaders;
}

export function wrapInSafeResponse(response: Response): Response {
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: getSafeProxyOutputHeaders(response),
  });
}
