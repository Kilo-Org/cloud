import http from 'node:http';
import type { IncomingMessage } from 'node:http';
import { Readable, type Duplex } from 'node:stream';
import type { ReadableStream as NodeWebReadableStream } from 'node:stream/web';
import { pipeline } from 'node:stream/promises';
import type { Context } from 'hono';
import { timingSafeTokenEqual } from './auth';
import type { Supervisor } from './supervisor';

export const DEFAULT_WS_IDLE_TIMEOUT_MS = 10 * 60 * 1000;
export const DEFAULT_WS_HANDSHAKE_TIMEOUT_MS = 5 * 1000;
export const DEFAULT_MAX_WS_CONNS = 100;

export type ProxyOptions = {
  expectedToken: string;
  requireProxyToken: boolean;
  supervisor?: Supervisor;
  backendHost?: string;
  backendPort?: number;
  wsIdleTimeoutMs?: number;
  wsHandshakeTimeoutMs?: number;
  maxWsConnections?: number;
  wsState?: {
    activeConnections: number;
  };
};

function getHeaderToken(header: string | string[] | undefined): string | undefined {
  if (Array.isArray(header)) return header[0];
  return header;
}

function hasValidProxyToken(
  token: string | undefined,
  requireProxyToken: boolean,
  expectedToken: string
): boolean {
  if (!requireProxyToken) return true;
  return timingSafeTokenEqual(token, expectedToken);
}

function headersToOutgoing(headers: Headers): http.OutgoingHttpHeaders {
  const out: http.OutgoingHttpHeaders = {};
  headers.forEach((value, key) => {
    const existing = out[key];
    if (existing === undefined) {
      out[key] = value;
      return;
    }
    if (Array.isArray(existing)) {
      existing.push(value);
      return;
    }
    out[key] = [String(existing), value];
  });
  return out;
}

function incomingHeadersToResponseHeaders(headers: http.IncomingHttpHeaders): Headers {
  const out = new Headers();
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const v of value) out.append(key, v);
      continue;
    }
    out.append(key, String(value));
  }
  return out;
}

export function createHttpProxy(options: ProxyOptions) {
  const backendHost = options.backendHost ?? '127.0.0.1';
  const backendPort = options.backendPort ?? 3001;

  return async (c: Context): Promise<Response> => {
    const token = c.req.header('x-kiloclaw-proxy-token');
    if (!hasValidProxyToken(token, options.requireProxyToken, options.expectedToken)) {
      const isUnknownControllerRoute = c.req.path.startsWith('/_kilo/');
      return c.json(
        isUnknownControllerRoute
          ? { code: 'controller_route_unavailable', error: 'Unauthorized' }
          : { error: 'Unauthorized' },
        401
      );
    }

    if (options.supervisor && options.supervisor.getState() !== 'running') {
      return c.json(
        { error: 'Gateway not ready' },
        { status: 503, headers: { 'Retry-After': '5' } }
      );
    }

    const incomingUrl = new URL(c.req.url);
    const method = c.req.method.toUpperCase();

    const headers = new Headers(c.req.raw.headers);
    headers.delete('x-kiloclaw-proxy-token');
    headers.set('host', `${backendHost}:${backendPort}`);

    // Stream the request body through http.request + stream.pipeline so we
    // never buffer uploads or large plugin payloads. Mirrors the WS-upgrade
    // path's use of http.request for raw Node stream control.
    return await new Promise<Response>(resolve => {
      const upstreamReq = http.request({
        hostname: backendHost,
        port: backendPort,
        path: `${incomingUrl.pathname}${incomingUrl.search}`,
        method,
        headers: headersToOutgoing(headers),
      });

      let settled = false;
      const settle = (response: Response): void => {
        if (settled) return;
        settled = true;
        resolve(response);
      };
      const fail = (error: unknown): void => {
        console.error('[controller] HTTP proxy backend error:', error);
        settle(
          new Response(JSON.stringify({ error: 'Bad Gateway' }), {
            status: 502,
            headers: { 'content-type': 'application/json' },
          })
        );
      };

      upstreamReq.on('error', fail);

      upstreamReq.on('response', (upstreamRes: IncomingMessage) => {
        const responseHeaders = incomingHeadersToResponseHeaders(upstreamRes.headers);
        const hasBody =
          method !== 'HEAD' && upstreamRes.statusCode !== 204 && upstreamRes.statusCode !== 304;
        if (!hasBody) {
          upstreamRes.resume();
          settle(
            new Response(null, {
              status: upstreamRes.statusCode ?? 502,
              headers: responseHeaders,
            })
          );
          return;
        }
        upstreamRes.on('error', err => {
          console.error('[controller] HTTP proxy upstream response error:', err);
        });
        // Node's stream/web ReadableStream and the DOM lib's ReadableStream have
        // drifted type shapes (ReadableStreamBYOBReader.readAtLeast etc.), but
        // they are structurally interchangeable at runtime. Same cast is used
        // for the inbound body in handleHttpRequest.
        const body = Readable.toWeb(upstreamRes) satisfies NodeWebReadableStream;
        settle(
          new Response(body as unknown as ReadableStream<Uint8Array>, {
            status: upstreamRes.statusCode ?? 502,
            headers: responseHeaders,
          })
        );
      });

      if (method === 'GET' || method === 'HEAD') {
        upstreamReq.end();
        return;
      }

      const requestBody = c.req.raw.body;
      if (!requestBody) {
        upstreamReq.end();
        return;
      }

      // The DOM lib's ReadableStream and Node's stream/web ReadableStream are
      // structurally interchangeable; same cast symmetry as the response body.
      const nodeBody = Readable.fromWeb(requestBody as unknown as NodeWebReadableStream);
      pipeline(nodeBody, upstreamReq).catch(err => {
        if (settled) {
          // Response already dispatched; surface the error and tear down upstream
          // so Hono's response writer propagates closure to the client.
          console.error('[controller] HTTP proxy request body pipe error:', err);
          upstreamReq.destroy();
          return;
        }
        fail(err);
      });
    });
  };
}

function socketWriteUnauthorized(socket: Duplex): void {
  socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
  socket.destroy();
}

function socketWriteBadGateway(socket: Duplex): void {
  socket.write('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
  socket.destroy();
}

function socketWriteServiceUnavailable(socket: Duplex): void {
  socket.write('HTTP/1.1 503 Service Unavailable\r\nRetry-After: 5\r\nConnection: close\r\n\r\n');
  socket.destroy();
}

function setDuplexTimeout(socket: Duplex, timeoutMs: number, onTimeout: () => void): void {
  const timeoutCapable = socket as unknown as {
    setTimeout?: (timeout: number, callback?: () => void) => void;
  };
  timeoutCapable.setTimeout?.(timeoutMs, onTimeout);
}

export function handleWebSocketUpgrade(
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  options: ProxyOptions
): void {
  const backendHost = options.backendHost ?? '127.0.0.1';
  const backendPort = options.backendPort ?? 3001;
  const wsIdleTimeoutMs = options.wsIdleTimeoutMs ?? DEFAULT_WS_IDLE_TIMEOUT_MS;
  const wsHandshakeTimeoutMs = options.wsHandshakeTimeoutMs ?? DEFAULT_WS_HANDSHAKE_TIMEOUT_MS;
  const maxWsConnections = options.maxWsConnections ?? DEFAULT_MAX_WS_CONNS;
  const wsState = options.wsState ?? { activeConnections: 0 };

  const token = getHeaderToken(req.headers['x-kiloclaw-proxy-token']);

  if (!hasValidProxyToken(token, options.requireProxyToken, options.expectedToken)) {
    socketWriteUnauthorized(socket);
    return;
  }

  if (options.supervisor && options.supervisor.getState() !== 'running') {
    socketWriteServiceUnavailable(socket);
    return;
  }
  if (wsState.activeConnections >= maxWsConnections) {
    socketWriteServiceUnavailable(socket);
    return;
  }

  wsState.activeConnections += 1;
  let releasedConnection = false;
  const releaseConnection = () => {
    if (releasedConnection) return;
    releasedConnection = true;
    wsState.activeConnections = Math.max(0, wsState.activeConnections - 1);
  };

  const forwardedHeaders = { ...req.headers };
  delete forwardedHeaders['x-kiloclaw-proxy-token'];
  // Rewrite Host so the gateway sees a loopback origin (matching the HTTP proxy path).
  // Strip proxy/forwarding headers injected by upstream proxies (Fly, CF) so the gateway's
  // isLocalDirectRequest check doesn't conclude the request came from a remote client.
  forwardedHeaders['host'] = `${backendHost}:${backendPort}`;
  delete forwardedHeaders['forwarded'];
  delete forwardedHeaders['x-forwarded-for'];
  delete forwardedHeaders['x-forwarded-proto'];
  delete forwardedHeaders['x-real-ip'];
  delete forwardedHeaders['x-forwarded-host'];

  const backendReq = http.request({
    hostname: backendHost,
    port: backendPort,
    path: req.url,
    method: req.method,
    headers: forwardedHeaders,
  });
  backendReq.setTimeout(wsHandshakeTimeoutMs, () => {
    socketWriteBadGateway(socket);
    backendReq.destroy();
    releaseConnection();
  });

  backendReq.on('upgrade', (backendRes, backendSocket, backendHead) => {
    backendReq.setTimeout(0);
    setDuplexTimeout(socket, wsIdleTimeoutMs, () => socket.destroy());
    backendSocket.setTimeout(wsIdleTimeoutMs, () => backendSocket.destroy());

    let tunnelClosed = false;
    const closeTunnel = () => {
      if (tunnelClosed) return;
      tunnelClosed = true;
      socket.destroy();
      backendSocket.destroy();
      releaseConnection();
    };

    let rawResponse = `HTTP/1.1 ${backendRes.statusCode ?? 101} ${
      backendRes.statusMessage ?? 'Switching Protocols'
    }\r\n`;
    for (let i = 0; i < backendRes.rawHeaders.length; i += 2) {
      rawResponse += `${backendRes.rawHeaders[i]}: ${backendRes.rawHeaders[i + 1]}\r\n`;
    }
    rawResponse += '\r\n';
    socket.write(rawResponse);

    if (backendHead.length > 0) {
      socket.write(backendHead);
    }
    if (head.length > 0) {
      backendSocket.write(head);
    }

    socket.pipe(backendSocket);
    backendSocket.pipe(socket);

    socket.on('error', () => closeTunnel());
    backendSocket.on('error', () => closeTunnel());
    socket.on('close', () => closeTunnel());
    backendSocket.on('close', () => closeTunnel());
  });

  backendReq.on('response', backendRes => {
    backendReq.setTimeout(0);
    setDuplexTimeout(socket, wsIdleTimeoutMs, () => socket.destroy());

    let closed = false;
    const closeResponse = () => {
      if (closed) return;
      closed = true;
      socket.destroy();
      releaseConnection();
    };

    let rawResponse = `HTTP/1.1 ${backendRes.statusCode ?? 502} ${
      backendRes.statusMessage ?? 'Bad Gateway'
    }\r\n`;
    for (let i = 0; i < backendRes.rawHeaders.length; i += 2) {
      rawResponse += `${backendRes.rawHeaders[i]}: ${backendRes.rawHeaders[i + 1]}\r\n`;
    }
    rawResponse += '\r\n';
    socket.write(rawResponse);
    backendRes.pipe(socket);
    backendRes.on('end', () => socket.end());
    backendRes.on('close', () => closeResponse());
    socket.on('close', () => closeResponse());
  });

  backendReq.on('error', error => {
    console.error('[controller] WebSocket proxy backend error:', error);
    socketWriteBadGateway(socket);
    releaseConnection();
  });

  backendReq.end();
}
