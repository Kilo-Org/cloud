import { WorkerEntrypoint } from 'cloudflare:workers';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { useWorkersLogger } from 'workers-tagged-logger';
import type { MiddlewareHandler } from 'hono';
import type { ConnectTicketResponse } from '@kilocode/event-service';
import {
  connectTicketQuerySchema,
  RequestDeadlineError,
  withDeadline,
} from '@kilocode/event-service';
import { extractBearerToken } from '@kilocode/worker-utils';
import { authenticateToken } from './auth';
import { configureDevLogging, logger, withLogTags } from './util/logger';
import { type TicketMintRequest } from './do/connection-ticket-do';

export { UserSessionDO } from './do/user-session-do';
export { ConnectionTicketDO } from './do/connection-ticket-do';

const app = new Hono<{ Bindings: Env }>();
const ACCEPTED_WEBSOCKET_PROTOCOL = 'kilo.events.v1';
const CONNECTION_TICKET_TTL_MS = 30_000;

/**
 * Total budget for one `/connect-ticket` mint: the bearer's pepper read through
 * Hyperdrive (`authenticateToken`) plus the per-ticket Durable Object mint
 * (`mintConnectionTicket`). Strictly below the client's
 * `CONTROL_PLANE_DEADLINE_MS` (15s) because the client gives up there, and
 * below the gateway's own budget: a mint that outlives either is a 504 with no
 * server-side attribution. Both hops are unbounded on their own — the Hyperdrive
 * read has no statement/connect budget and every ticket targets a fresh,
 * therefore cold, Durable Object — so they share one deadline. On expiry the
 * route answers with its retryable mint-failure response, which the client
 * already treats as a reconnect-and-retry
 * (packages/event-service/src/client.ts).
 */
export const TICKET_MINT_BUDGET_MS = 8_000;

type TicketMintOutcome = 'ok' | 'unauthorized' | 'mint_failed' | 'timeout';

type TicketMintResult =
  | { outcome: 'ok'; ticket: string; userId: string }
  | { outcome: Exclude<TicketMintOutcome, 'ok'> };

/**
 * One allow-listed line per request, emitted with `console.log` rather than
 * the tagged logger on purpose: the request's async context carries a `userId`
 * tag, and a duration line must never carry a user id — or a query string, an
 * `Authorization` header, a token, or a request body. Only these five fields.
 */
type RequestDurationLine = {
  route: string;
  method: string;
  status: number;
  durationMs: number;
  outcome: TicketMintOutcome;
};

function logRequestDuration(line: RequestDurationLine): void {
  console.log(JSON.stringify(line));
}
const ALLOWED_BROWSER_ORIGINS = ['https://kilo.ai', 'https://app.kilo.ai', 'http://localhost:3000'];
const LOCALHOST_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

function allowedOrigin(origin: string, env: { WORKER_ENV?: string }): string | null {
  if (ALLOWED_BROWSER_ORIGINS.includes(origin)) return origin;
  if (env.WORKER_ENV === 'development' && LOCALHOST_ORIGIN.test(origin)) return origin;
  return null;
}

app.use(
  '/connect/*',
  cors({ origin: (origin, c) => allowedOrigin(origin, c.env as Pick<Env, 'WORKER_ENV'>) })
);
app.use(
  '/connect-ticket',
  cors({
    origin: (origin, c) => allowedOrigin(origin, c.env as Pick<Env, 'WORKER_ENV'>),
    allowMethods: ['POST', 'OPTIONS'],
    allowHeaders: ['Authorization'],
  })
);

// ── Structured logging context ──────────────────────────────────────────
app.use('*', useWorkersLogger('event-service') as unknown as MiddlewareHandler);
// Enable debug logs for the request only in local dev (WORKER_ENV === 'development').
app.use('*', async (c, next) => {
  configureDevLogging(c.env);
  await next();
});

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

/**
 * Authenticate the bearer and mint the ticket under one deadline. The auth read
 * and the mint share the same budget, so a stalled hop in either resolves the
 * route with `timeout` instead of hanging past the gateway's budget. A rejected
 * hop is reported as `mint_failed` — the same retryable failure the client
 * already reconnects and retries on.
 */
async function authenticateAndMintTicket(
  env: Env,
  token: string | null
): Promise<TicketMintResult> {
  try {
    return await withDeadline(TICKET_MINT_BUDGET_MS, async () => {
      const auth = await authenticateToken(token, env);
      if (!auth) {
        return { outcome: 'unauthorized' } satisfies TicketMintResult;
      }

      const ticket = await mintConnectionTicket(env, auth.userId);
      if (!ticket) {
        return { outcome: 'mint_failed' } satisfies TicketMintResult;
      }

      return { outcome: 'ok', ticket, userId: auth.userId } satisfies TicketMintResult;
    });
  } catch (err) {
    if (err instanceof RequestDeadlineError) {
      logger.debug('connect-ticket: mint budget expired', { budgetMs: TICKET_MINT_BUDGET_MS });
      return { outcome: 'timeout' };
    }
    return { outcome: 'mint_failed' };
  }
}

app.post('/connect-ticket', async c => {
  const startedAt = Date.now();
  const token = extractBearerToken(c.req.header('authorization'));
  const result = await authenticateAndMintTicket(c.env, token);

  if (result.outcome === 'unauthorized') {
    logger.debug('connect-ticket: unauthorized');
    logRequestDuration({
      route: '/connect-ticket',
      method: c.req.method,
      status: 401,
      durationMs: Date.now() - startedAt,
      outcome: result.outcome,
    });
    return c.json({ error: 'Unauthorized' }, 401);
  }

  if (result.outcome !== 'ok') {
    logger.debug('connect-ticket: mint failed', { outcome: result.outcome });
    logRequestDuration({
      route: '/connect-ticket',
      method: c.req.method,
      status: 500,
      durationMs: Date.now() - startedAt,
      outcome: result.outcome,
    });
    return c.json({ error: 'Ticket mint failed' }, 500);
  }

  logger.setTags({ userId: result.userId });
  logger.debug('connect-ticket: minted');

  logRequestDuration({
    route: '/connect-ticket',
    method: c.req.method,
    status: 200,
    durationMs: Date.now() - startedAt,
    outcome: result.outcome,
  });

  const response = { ticket: result.ticket } satisfies ConnectTicketResponse;
  return c.json(response);
});

app.get('/connect', async c => {
  if (c.req.header('Upgrade') !== 'websocket') {
    logger.debug('connect: expected websocket upgrade');
    return c.json({ error: 'Expected WebSocket upgrade' }, 426);
  }

  const query = connectTicketQuerySchema.safeParse({ ticket: c.req.query('ticket') });
  if (!query.success) {
    logger.debug('connect: missing ticket');
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const userId = await consumeConnectionTicket(c.env, query.data.ticket);
  if (!userId) {
    logger.debug('connect: ticket consume failed');
    return c.json({ error: 'Unauthorized' }, 401);
  }
  logger.setTags({ userId });
  logger.debug('connect: websocket upgrade', { userId });

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
    return withLogTags({ source: 'event-service.pushEvent' }, async () => {
      configureDevLogging(this.env);
      logger.setTags({ userId, context, event });
      logger.debug('pushEvent: received');
      const stub = this.env.USER_SESSION_DO.get(this.env.USER_SESSION_DO.idFromName(userId));
      const delivered = await stub.pushEvent(context, event, payload);
      logger.debug('pushEvent: delivered', { delivered });
      return delivered;
    });
  }

  async isUserInContext(userId: string, context: string): Promise<boolean> {
    return withLogTags({ source: 'event-service.isUserInContext' }, async () => {
      configureDevLogging(this.env);
      logger.setTags({ userId, context });
      const stub = this.env.USER_SESSION_DO.get(this.env.USER_SESSION_DO.idFromName(userId));
      const present = await stub.hasContext(context);
      logger.debug('isUserInContext', { present });
      return present;
    });
  }
}
