import { WorkerEntrypoint } from 'cloudflare:workers';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { useWorkersLogger } from 'workers-tagged-logger';
import type { MiddlewareHandler } from 'hono';
import type { ConnectTicketResponse } from '@kilocode/event-service';
import { connectTicketQuerySchema } from '@kilocode/event-service';
import { extractBearerToken } from '@kilocode/worker-utils';
import { authenticateToken } from './auth';
import { logger } from './util/logger';
import { type TicketMintRequest } from './do/connection-ticket-do';

export { UserSessionDO } from './do/user-session-do';
export { ConnectionTicketDO } from './do/connection-ticket-do';

const app = new Hono<{ Bindings: Env }>();
const ACCEPTED_WEBSOCKET_PROTOCOL = 'kilo.events.v1';
const CONNECTION_TICKET_TTL_MS = 30_000;
const ALLOWED_BROWSER_ORIGINS = ['https://kilo.ai', 'https://app.kilo.ai', 'http://localhost:3000'];

app.use(
  '/connect/*',
  cors({ origin: origin => (ALLOWED_BROWSER_ORIGINS.includes(origin) ? origin : null) })
);
app.use(
  '/connect-ticket',
  cors({
    origin: origin => (ALLOWED_BROWSER_ORIGINS.includes(origin) ? origin : null),
    allowMethods: ['POST', 'OPTIONS'],
    allowHeaders: ['Authorization'],
  })
);

// ── Structured logging context ──────────────────────────────────────────
app.use('*', useWorkersLogger('event-service') as unknown as MiddlewareHandler);

app.get('/health', c => c.json({ ok: true }));

function acceptsWebSocketProtocol(header: string | undefined): boolean {
  if (!header) return false;
  for (const raw of header.split(',')) {
    if (raw.trim() === ACCEPTED_WEBSOCKET_PROTOCOL) return true;
  }
  return false;
}

async function mintConnectionTicket(env: Env, userId: string): Promise<string | null> {
  const ticket = crypto.randomUUID();
  const stub = env.CONNECTION_TICKET_DO.get(env.CONNECTION_TICKET_DO.idFromName(ticket));
  const body = {
    userId,
    expiresAt: Date.now() + CONNECTION_TICKET_TTL_MS,
  } satisfies TicketMintRequest;
  try {
    await stub.mint(body);
    return ticket;
  } catch {
    return null;
  }
}

async function consumeConnectionTicket(env: Env, ticket: string): Promise<string | null> {
  const stub = env.CONNECTION_TICKET_DO.get(env.CONNECTION_TICKET_DO.idFromName(ticket));
  try {
    return (await stub.consume())?.userId ?? null;
  } catch {
    return null;
  }
}

app.post('/connect-ticket', async c => {
  const token = extractBearerToken(c.req.header('authorization'));
  const auth = await authenticateToken(token, c.env);
  if (!auth) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const ticket = await mintConnectionTicket(c.env, auth.userId);
  if (!ticket) {
    return c.json({ error: 'Ticket mint failed' }, 500);
  }

  const response = { ticket } satisfies ConnectTicketResponse;
  return c.json(response);
});

app.get('/connect', async c => {
  if (c.req.header('Upgrade') !== 'websocket') {
    return c.json({ error: 'Expected WebSocket upgrade' }, 426);
  }

  const query = connectTicketQuerySchema.safeParse({ ticket: c.req.query('ticket') });
  if (!query.success) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const userId = await consumeConnectionTicket(c.env, query.data.ticket);
  if (!userId) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  logger.setTags({ userId });

  const doId = c.env.USER_SESSION_DO.idFromName(userId);
  const stub = c.env.USER_SESSION_DO.get(doId);
  const shouldEchoProtocol = acceptsWebSocketProtocol(c.req.header('Sec-WebSocket-Protocol'));

  const upstreamHeaders = new Headers(c.req.raw.headers);
  if (shouldEchoProtocol) {
    upstreamHeaders.set('Sec-WebSocket-Protocol', ACCEPTED_WEBSOCKET_PROTOCOL);
  } else {
    upstreamHeaders.delete('Sec-WebSocket-Protocol');
  }
  const upstreamRequest = new Request(c.req.raw.url, {
    method: c.req.raw.method,
    headers: upstreamHeaders,
  });
  const response = await stub.fetch(upstreamRequest);

  const responseHeaders = new Headers(response.headers);
  if (shouldEchoProtocol) {
    responseHeaders.set('Sec-WebSocket-Protocol', ACCEPTED_WEBSOCKET_PROTOCOL);
  }
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

  async isUserInContext(userId: string, context: string): Promise<boolean> {
    logger.setTags({ userId, context });
    const stub = this.env.USER_SESSION_DO.get(this.env.USER_SESSION_DO.idFromName(userId));
    return stub.hasContext(context);
  }
}
