import { WorkerEntrypoint } from 'cloudflare:workers';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { ConnectTicketResponse } from '@kilocode/event-service';
import { connectQuerySchema } from '@kilocode/event-service';
import { useWorkersLogger } from 'workers-tagged-logger';
import type { MiddlewareHandler } from 'hono';
import { authenticateToken } from './auth';
import { logger } from './util/logger';

export { UserSessionDO } from './do/user-session-do';
export { TicketDO } from './do/ticket-do';

const app = new Hono<{ Bindings: Env }>();

app.use(
  '/connect/*',
  cors({ origin: ['https://kilo.ai', 'https://app.kilo.ai', 'http://localhost:3000'] })
);

// ── Structured logging context ──────────────────────────────────────────
app.use('*', useWorkersLogger('event-service') as unknown as MiddlewareHandler);

app.get('/health', c => c.json({ ok: true }));

// Step 1: Exchange JWT for a short-lived, single-use connection ticket.
app.post('/connect/ticket', async c => {
  const authHeader = c.req.header('Authorization');
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
  const auth = await authenticateToken(token, c.env);
  if (!auth) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  logger.setTags({ userId: auth.userId });

  const ticketDO = c.env.TICKET_DO.get(c.env.TICKET_DO.idFromName(auth.userId));
  const ticket = await ticketDO.create(auth.userId);
  return c.json({ ticket, userId: auth.userId } satisfies ConnectTicketResponse);
});

// Step 2: Connect WebSocket using the ticket.
app.get('/connect', async c => {
  const result = connectQuerySchema.safeParse({
    ticket: c.req.query('ticket'),
    userId: c.req.query('userId'),
  });
  if (!result.success) {
    return c.json({ error: 'Missing ticket or userId' }, 400);
  }
  const { ticket, userId } = result.data;

  const ticketDO = c.env.TICKET_DO.get(c.env.TICKET_DO.idFromName(userId));
  const redeemedUserId = await ticketDO.redeem(ticket);
  if (!redeemedUserId) {
    return c.json({ error: 'Invalid or expired ticket' }, 401);
  }
  logger.setTags({ userId: redeemedUserId });

  const doId = c.env.USER_SESSION_DO.idFromName(redeemedUserId);
  const stub = c.env.USER_SESSION_DO.get(doId);
  return stub.fetch(c.req.raw);
});

export default class extends WorkerEntrypoint<Env> {
  async fetch(request: Request): Promise<Response> {
    return app.fetch(request, this.env, this.ctx);
  }

  async pushEvent(
    userId: string,
    context: string,
    event: string,
    payload: unknown
  ): Promise<boolean> {
    logger.setTags({ userId, context, event });
    const stub = this.env.USER_SESSION_DO.get(this.env.USER_SESSION_DO.idFromName(userId));
    return stub.pushEvent(context, event, payload);
  }
}
