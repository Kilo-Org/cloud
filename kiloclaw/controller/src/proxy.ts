import http from 'node:http';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type { Context } from 'hono';

export const DEFAULT_WS_IDLE_TIMEOUT_MS = 10 * 60 * 1000;
export const DEFAULT_WS_HANDSHAKE_TIMEOUT_MS = 5 * 1000;
export const DEFAULT_MAX_WS_CONNS = 100;

export type ProxyOptions = {
  expectedToken: string;
  requireProxyToken: boolean;
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
  return token === expectedToken;
}

export function createHttpProxy(options: ProxyOptions) {
  const backendHost = options.backendHost ?? '127.0.0.1';
  const backendPort = options.backendPort ?? 3001;
  const backendOrigin = `http://${backendHost}:${backendPort}`;

  return async (c: Context): Promise<Response> => {
    const token = c.req.header('x-kiloclaw-proxy-token');
    if (!hasValidProxyToken(token, options.requireProxyToken, options.expectedToken)) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    const incomingUrl = new URL(c.req.url);
    const backendUrl = new URL(`${incomingUrl.pathname}${incomingUrl.search}`, backendOrigin);

    const headers = new Headers(c.req.raw.headers);
    headers.delete('x-kiloclaw-proxy-token');
    headers.set('host', `${backendHost}:${backendPort}`);

    const method = c.req.method.toUpperCase();
    const init: RequestInit & { duplex?: 'half' } = {
      method,
      headers,
      redirect: 'manual',
    };

    if (method !== 'GET' && method !== 'HEAD') {
      init.body = c.req.raw.body;
      init.duplex = 'half';
    }

    try {
      const resp = await fetch(backendUrl, init);
      return new Response(resp.body, {
        status: resp.status,
        headers: resp.headers,
      });
    } catch (error) {
      console.error('[controller] HTTP proxy backend error:', error);
      return c.json({ error: 'Bad Gateway' }, 502);
    }
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
  socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
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
