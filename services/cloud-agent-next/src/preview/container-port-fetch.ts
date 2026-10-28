import { stripPreviewMarkerHeaders } from '../shared/preview-headers.js';
import { isValidPreviewPort } from './host.js';
import { previewUpstreamHost, previewUpstreamUrl } from './upstream.js';
import { bridgeSockets } from './websocket-bridge.js';

// Time to response headers. A dev server can compile a page on its first request.
export const PREVIEW_UPSTREAM_TIMEOUT_MS = 60_000;

export type PreviewContainerTcpPort = {
  fetch(url: string, request: Request): Promise<Response>;
};

export type PreviewContainerPort = {
  readonly running: boolean;
  getTcpPort(port: number): PreviewContainerTcpPort;
};

export const PREVIEW_NOT_RUNNING_TEXT = 'The sandbox is not running';
export const PREVIEW_RESERVED_PORT_TEXT = 'That port is reserved';
/** A preview URL opened without its cookie, for example from a copied link. */
export const PREVIEW_SESSION_MISSING_TEXT =
  'Preview session is missing or expired. Open the preview again from the chat.';

export function previewNotRunningResponse(): Response {
  return fixedResponse(503, PREVIEW_NOT_RUNNING_TEXT);
}

function fixedResponse(status: number, message: string): Response {
  return new Response(message, {
    status,
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
}

function isAbortError(error: unknown): boolean {
  const seen = new Set<unknown>();
  const stack: unknown[] = [error];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined || current === null || seen.has(current)) continue;
    seen.add(current);
    if (typeof current !== 'object') continue;
    const record = current as { name?: unknown; cause?: unknown };
    if (record.name === 'AbortError' || record.name === 'TimeoutError') return true;
    if (record.cause !== undefined) stack.push(record.cause);
  }
  return false;
}

function buildUpstreamRequest(
  request: Request,
  url: string,
  port: number,
  signal: AbortSignal
): Request {
  const headers = stripPreviewMarkerHeaders(request.headers);
  headers.set('Host', previewUpstreamHost(port));
  const init: RequestInit & { duplex?: 'half' } = {
    method: request.method,
    headers,
    redirect: 'manual',
    signal,
  };
  if (request.body !== null && request.method !== 'GET' && request.method !== 'HEAD') {
    init.body = request.body;
    init.duplex = 'half';
  }
  return new Request(url, init);
}

function bridgeWebSocket(response: Response): Response {
  const containerSocket = response.webSocket;
  if (containerSocket === null || containerSocket === undefined) {
    return new Response(null, { status: response.status, headers: response.headers });
  }
  const pair = new WebSocketPair();
  bridgeSockets(pair[1], containerSocket);
  return new Response(null, {
    status: response.status,
    webSocket: pair[0],
    headers: response.headers,
  });
}

export async function fetchPreviewPort(
  container: PreviewContainerPort,
  port: number,
  request: Request,
  isReserved: (port: number) => boolean
): Promise<Response> {
  if (!isValidPreviewPort(port) || isReserved(port)) {
    return fixedResponse(403, PREVIEW_RESERVED_PORT_TEXT);
  }
  if (container.running !== true) {
    return previewNotRunningResponse();
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PREVIEW_UPSTREAM_TIMEOUT_MS);
  let response: Response;
  try {
    const incoming = new URL(request.url);
    const url = previewUpstreamUrl(incoming.pathname, incoming.search, port);
    response = await container
      .getTcpPort(port)
      .fetch(url, buildUpstreamRequest(request, url, port, controller.signal));
  } catch (error) {
    clearTimeout(timer);
    if (isAbortError(error)) {
      return fixedResponse(504, 'The server on that port did not respond in time');
    }
    return fixedResponse(502, 'Nothing is listening on that port');
  }
  clearTimeout(timer);

  if (response.webSocket !== null && response.webSocket !== undefined) {
    return bridgeWebSocket(response);
  }
  return new Response(response.body, { status: response.status, headers: response.headers });
}
