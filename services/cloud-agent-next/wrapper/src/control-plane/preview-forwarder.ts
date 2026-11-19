import { PREVIEW_MARKER_PREFIX } from '../../../src/shared/preview-headers.js';
import { PREVIEW_PORT_MAX, PREVIEW_PORT_MIN } from '../../../src/shared/preview-port.js';
import { previewResponseHasNoBody } from '../../../src/shared/preview-tunnel-protocol.js';
import { closeWebSocketQuietly as closeQuietly } from '../../../src/shared/websocket-close.js';

/**
 * Forwards one preview request to a dev server on loopback. It targets only
 * 127.0.0.1, then ::1, and refuses the provider's reserved ports and the live
 * Kilo server ports. The caller (the preview tunnel) owns the transport.
 */

export type PreviewForwardFailure = 'reserved' | 'not_listening' | 'timeout' | 'invalid';

export type PreviewForwarderDeps = {
  /** Provider reserved ports and live Kilo ports, read on each request. */
  refusedPorts: () => readonly number[];
  /** Time to the response headers. */
  headTimeoutMs: number;
  /** Time to an open upstream WebSocket. */
  socketTimeoutMs: number;
};

export type PreviewHttpRequest = {
  port: number;
  method: string;
  /** Path and query; it must start with `/`. */
  path: string;
  headers: Headers;
  body: ReadableStream<Uint8Array> | null;
  signal: AbortSignal;
};

export type PreviewSocketRequest = {
  port: number;
  path: string;
  headers: Headers;
  protocols: string[];
};

export type PreviewForwardResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: PreviewForwardFailure };

export type PreviewForwarder = {
  fetch(request: PreviewHttpRequest): Promise<PreviewForwardResult<Response>>;
  openSocket(request: PreviewSocketRequest): Promise<PreviewForwardResult<WebSocket>>;
};

const DROPPED_UPSTREAM_HEADERS = new Set([
  'host',
  'connection',
  'keep-alive',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'content-length',
  'forwarded',
  'x-real-ip',
  'accept-encoding',
]);

const DROPPED_UPSTREAM_PREFIXES = [
  'proxy-',
  'sec-websocket-',
  'x-forwarded-',
  PREVIEW_MARKER_PREFIX,
];

/** The request headers a dev server sees: no proxy, marker or hop-by-hop header. */
export function upstreamHeaders(source: Headers, port: number): Headers {
  const headers = new Headers();
  for (const [name, value] of source) {
    const lower = name.toLowerCase();
    if (DROPPED_UPSTREAM_HEADERS.has(lower)) continue;
    if (DROPPED_UPSTREAM_PREFIXES.some(prefix => lower.startsWith(prefix))) continue;
    headers.append(name, value);
  }
  headers.set('host', `localhost:${port}`);
  if (headers.has('origin')) headers.set('origin', `http://localhost:${port}`);
  // Bun asks for a compressed body unless told otherwise.
  headers.set('accept-encoding', 'identity');
  return headers;
}

const DROPPED_DOWNSTREAM_HEADERS = new Set([
  'connection',
  'keep-alive',
  'transfer-encoding',
  'content-length',
  'set-cookie',
]);

/** The dev server's response headers, without hop-by-hop or marker headers. */
export function downstreamHeaders(source: Headers): Headers {
  const headers = new Headers();
  for (const [name, value] of source) {
    const lower = name.toLowerCase();
    if (DROPPED_DOWNSTREAM_HEADERS.has(lower)) continue;
    if (lower.startsWith(PREVIEW_MARKER_PREFIX)) continue;
    headers.append(name, value);
  }
  for (const cookie of source.getSetCookie()) headers.append('set-cookie', cookie);
  return headers;
}

const LOOPBACK_HOSTS = ['127.0.0.1', '::1'] as const;
type LoopbackHost = (typeof LOOPBACK_HOSTS)[number];

async function accepts(hostname: LoopbackHost, port: number): Promise<boolean> {
  try {
    const socket = await Bun.connect({ hostname, port, socket: { data() {}, error() {} } });
    socket.end();
    return true;
  } catch {
    return false;
  }
}

/** The loopback address that accepts on `port`. */
async function listeningHost(port: number): Promise<LoopbackHost | null> {
  for (const hostname of LOOPBACK_HOSTS) {
    if (await accepts(hostname, port)) return hostname;
  }
  return null;
}

/** The loopback URL for `path`, or null when the path could leave the loopback origin. */
function loopbackUrl(
  scheme: 'http' | 'ws',
  host: LoopbackHost,
  port: number,
  path: string
): string | null {
  if (!path.startsWith('/')) return null;
  const origin = `${scheme}://${host === '::1' ? '[::1]' : host}:${port}`;
  try {
    const url = new URL(`${origin}${path}`);
    return url.origin === new URL(origin).origin ? url.toString() : null;
  } catch {
    return null;
  }
}

function isPreviewPort(port: number): boolean {
  return Number.isInteger(port) && port >= PREVIEW_PORT_MIN && port <= PREVIEW_PORT_MAX;
}

class PreviewDeadlineError extends Error {
  constructor() {
    super('Preview upstream deadline passed');
  }
}

/** Races `work` against a deadline; the timer never outlives `work`. */
async function withDeadline<T>(
  timeoutMs: number,
  work: (signal: AbortSignal) => Promise<T>
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new PreviewDeadlineError()), timeoutMs);
  try {
    return await Promise.race([
      work(controller.signal),
      new Promise<never>((_, reject) => {
        controller.signal.addEventListener('abort', () => reject(new PreviewDeadlineError()), {
          once: true,
        });
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Bun's client accepts headers and protocols; the DOM constructor type does not show them. */
type WebSocketWithOptionsCtor = new (
  url: string,
  options: { headers: Headers; protocols: string[] }
) => WebSocket;
const WebSocketWithOptions = WebSocket as unknown as WebSocketWithOptionsCtor;

/** Opens the upstream socket; rejects on error, close or abort before open. */
function openUpstreamSocket(
  url: string,
  headers: Headers,
  protocols: string[],
  signal: AbortSignal
): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocketWithOptions(url, { headers, protocols });
    socket.binaryType = 'arraybuffer';
    const cleanup = (): void => {
      socket.removeEventListener('open', onOpen);
      socket.removeEventListener('error', onFailure);
      socket.removeEventListener('close', onFailure);
      signal.removeEventListener('abort', onAbort);
    };
    const onOpen = (): void => {
      cleanup();
      resolve(socket);
    };
    const onFailure = (): void => {
      cleanup();
      reject(new Error('Preview upstream WebSocket failed'));
    };
    const onAbort = (): void => {
      cleanup();
      closeQuietly(socket, 1000, '');
      reject(new PreviewDeadlineError());
    };
    socket.addEventListener('open', onOpen);
    socket.addEventListener('error', onFailure);
    socket.addEventListener('close', onFailure);
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

function failureOf(error: unknown): PreviewForwardFailure {
  return error instanceof PreviewDeadlineError ? 'timeout' : 'not_listening';
}

export function createPreviewForwarder(deps: PreviewForwarderDeps): PreviewForwarder {
  const isRefused = (port: number): boolean =>
    !isPreviewPort(port) || deps.refusedPorts().includes(port);

  async function fetchLoopback(
    request: PreviewHttpRequest
  ): Promise<PreviewForwardResult<Response>> {
    if (isRefused(request.port)) return { ok: false, reason: 'reserved' };
    if (loopbackUrl('http', '127.0.0.1', request.port, request.path) === null) {
      return { ok: false, reason: 'invalid' };
    }
    const method = request.method.toUpperCase();
    try {
      const upstream = await withDeadline(deps.headTimeoutMs, async deadline => {
        const host = await listeningHost(request.port);
        if (host === null) return null;
        return fetch(loopbackUrl('http', host, request.port, request.path) ?? '', {
          method: request.method,
          headers: upstreamHeaders(request.headers, request.port),
          ...(method === 'GET' || method === 'HEAD' ? {} : { body: request.body }),
          redirect: 'manual',
          decompress: false,
          signal: AbortSignal.any([request.signal, deadline]),
        });
      });
      if (upstream === null) return { ok: false, reason: 'not_listening' };
      const body = previewResponseHasNoBody(method, upstream.status) ? null : upstream.body;
      if (body === null) void upstream.body?.cancel().catch(() => undefined);
      return {
        ok: true,
        value: new Response(body, {
          status: upstream.status,
          statusText: upstream.statusText,
          headers: downstreamHeaders(upstream.headers),
        }),
      };
    } catch (error) {
      return { ok: false, reason: failureOf(error) };
    }
  }

  async function openLoopbackSocket(
    request: PreviewSocketRequest
  ): Promise<PreviewForwardResult<WebSocket>> {
    if (isRefused(request.port)) return { ok: false, reason: 'reserved' };
    if (loopbackUrl('ws', '127.0.0.1', request.port, request.path) === null) {
      return { ok: false, reason: 'invalid' };
    }
    try {
      const socket = await withDeadline(deps.socketTimeoutMs, async deadline => {
        const host = await listeningHost(request.port);
        if (host === null) return null;
        return openUpstreamSocket(
          loopbackUrl('ws', host, request.port, request.path) ?? '',
          upstreamHeaders(request.headers, request.port),
          request.protocols,
          deadline
        );
      });
      return socket === null ? { ok: false, reason: 'not_listening' } : { ok: true, value: socket };
    } catch (error) {
      return { ok: false, reason: failureOf(error) };
    }
  }

  return { fetch: fetchLoopback, openSocket: openLoopbackSocket };
}
