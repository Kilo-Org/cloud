import { WorkerEntrypoint } from 'cloudflare:workers';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { authenticateToken } from './auth';

export { UserSessionDO } from './do/user-session-do';
export { TicketDO } from './do/ticket-do';

const app = new Hono<{ Bindings: Env }>();

app.use('/connect/*', cors());
app.get('/health', c => c.json({ ok: true }));

// Step 1: Exchange JWT for a short-lived, single-use connection ticket.
app.post('/connect/ticket', async c => {
  const authHeader = c.req.header('Authorization');
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
  const auth = await authenticateToken(token, c.env);
  if (!auth) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const ticketDO = c.env.TICKET_DO.get(c.env.TICKET_DO.idFromName(auth.userId));
  const ticket = await ticketDO.create(auth.userId);
  return c.json({ ticket, userId: auth.userId });
});

// Step 2: Connect WebSocket using the ticket.
app.get('/connect', async c => {
  const ticket = c.req.query('ticket') ?? null;
  const userId = c.req.query('userId') ?? null;
  if (!ticket || !userId) {
    return c.json({ error: 'Missing ticket or userId' }, 400);
  }

  const ticketDO = c.env.TICKET_DO.get(c.env.TICKET_DO.idFromName(userId));
  const redeemedUserId = await ticketDO.redeem(ticket);
  if (!redeemedUserId) {
    return c.json({ error: 'Invalid or expired ticket' }, 401);
  }

  const doId = c.env.USER_SESSION_DO.idFromName(userId);
  const stub = c.env.USER_SESSION_DO.get(doId);
  return stub.fetch(c.req.raw);
});

export default class extends WorkerEntrypoint<Env> {
  async fetch(request: Request): Promise<Response> {
    return app.fetch(request, this.env, this.ctx);
  }

  async pushEvent(userId: string, context: string, event: string, payload: unknown): Promise<void> {
    const doId = this.env.USER_SESSION_DO.idFromName(userId);
    const stub = this.env.USER_SESSION_DO.get(doId);
    await stub.pushEvent(context, event, payload);
  }

  async userPresent(userId: string, context: string): Promise<boolean> {
    const doId = this.env.USER_SESSION_DO.idFromName(userId);
    const stub = this.env.USER_SESSION_DO.get(doId);
    return stub.userPresent(context);
  }
}
