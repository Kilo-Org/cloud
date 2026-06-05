const BODYLESS_METHODS = new Set(['GET', 'HEAD']);

const STRIPPED_PROXY_REQUEST_HEADERS = new Set([
  'authorization',
  'cookie',
  'host',
  'connection',
  'content-length',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'sec-websocket-accept',
  'sec-websocket-extensions',
  'sec-websocket-key',
  'sec-websocket-protocol',
  'sec-websocket-version',
  'x-kilo-facade-user-id',
  'x-kilo-facade-auth-token',
]);

export function requestMethodAllowsBody(method: string): boolean {
  return !BODYLESS_METHODS.has(method.toUpperCase());
}

export function cloneProxyRequestHeaders(headers: Headers): Headers {
  const forwarded = new Headers();
  headers.forEach((value, key) => {
    if (STRIPPED_PROXY_REQUEST_HEADERS.has(key.toLowerCase())) {
      return;
    }
    forwarded.append(key, value);
  });
  return forwarded;
}

export function createProxyRequest(sourceRequest: Request, targetUrl: string | URL): Request {
  const init: RequestInit & { duplex?: 'half' } = {
    method: sourceRequest.method,
    headers: cloneProxyRequestHeaders(sourceRequest.headers),
  };

  if (sourceRequest.body && requestMethodAllowsBody(sourceRequest.method)) {
    init.body = sourceRequest.body;
    init.duplex = 'half';
  }

  return new Request(targetUrl, init);
}
