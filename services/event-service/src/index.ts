import { WorkerEntrypoint } from 'cloudflare:workers';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { useWorkersLogger } from 'workers-tagged-logger';
import type { MiddlewareHandler } from 'hono';
import { authenticateToken } from './auth';
import { logger } from './util/logger';

export { UserSessionDO } from './do/user-session-do';

const app = new Hono<{ Bindings: Env }>();

app.use('/connect/*', cors({ origin: ['https://kilo.ai', 'https://app.kilo.ai'] }));

// ── Structured logging context ──────────────────────────────────────────
app.use('*', useWorkersLogger('event-service') as unknown as MiddlewareHandler);

app.get('/health', c => c.json({ ok: true }));

// Subprotocol format: a single protocol string "kilo.jwt.<base64url-jwt>".
// The JWT itself contains characters like '.' (allowed) but base64 characters
// '/' and '+' are not HTTP token chars, so we base64url-encode before joining
// to keep the subprotocol a valid token per RFC 6455 / RFC 7230.
const SUBPROTOCOL_PREFIX = 'kilo.jwt.';

function extractSubprotocol(header: string | undefined): { proto: string; jwt: string } | null {
  if (!header) return null;
  // Sec-WebSocket-Protocol is a comma-separated list; accept any entry
  // matching the "kilo.jwt.<encoded>" shape.
  for (const raw of header.split(',')) {
    const proto = raw.trim();
    if (proto.startsWith(SUBPROTOCOL_PREFIX)) {
      const encoded = proto.slice(SUBPROTOCOL_PREFIX.length);
      const jwt = decodeBase64UrlToString(encoded);
      if (jwt) return { proto, jwt };
    }
  }
  return null;
}

function decodeBase64UrlToString(encoded: string): string | null {
  try {
    const base64 = encoded.replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
    return atob(padded);
  } catch {
    return null;
  }
}

// WebSocket connect: JWT is passed via Sec-WebSocket-Protocol as
// "kilo.jwt.<base64url-encoded-jwt>". The server echoes the accepted
// subprotocol back so the browser completes the handshake.
app.get('/connect', async c => {
  if (c.req.header('Upgrade') !== 'websocket') {
    return c.json({ error: 'Expected WebSocket upgrade' }, 426);
  }

  const sub = extractSubprotocol(c.req.header('Sec-WebSocket-Protocol'));
  if (!sub) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const auth = await authenticateToken(sub.jwt, c.env);
  if (!auth) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  logger.setTags({ userId: auth.userId });

  const doId = c.env.USER_SESSION_DO.idFromName(auth.userId);
  const stub = c.env.USER_SESSION_DO.get(doId);

  // Forward to the DO with a Sec-WebSocket-Protocol value the DO can accept
  // without having to know the JWT itself.
  const upstreamHeaders = new Headers(c.req.raw.headers);
  upstreamHeaders.set('Sec-WebSocket-Protocol', sub.proto);
  const upstreamRequest = new Request(c.req.raw.url, {
    method: c.req.raw.method,
    headers: upstreamHeaders,
  });
  const response = await stub.fetch(upstreamRequest);

  // Echo the accepted subprotocol back to the browser so the upgrade succeeds.
  const responseHeaders = new Headers(response.headers);
  responseHeaders.set('Sec-WebSocket-Protocol', sub.proto);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: responseHeaders,
    webSocket: response.webSocket,
  });
});

export default class extends WorkerEntrypoint<Env> {
  async fetch(request: Request): Promise<Response> {
    return app.fetch(request, this.env, this.ctx);
  }

  // Generic over the event-name type so domain packages (e.g. kilo-chat) can
  // constrain their own producer bindings to a known event-name union while
  // event-service itself stays domain-agnostic.
  async pushEvent<Name extends string>(
    userId: string,
    context: string,
    event: Name,
    payload: unknown
  ): Promise<boolean> {
    logger.setTags({ userId, context, event });
    const stub = this.env.USER_SESSION_DO.get(this.env.USER_SESSION_DO.idFromName(userId));
    return stub.pushEvent(context, event, payload);
  }
}
