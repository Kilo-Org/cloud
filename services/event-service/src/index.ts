import { WorkerEntrypoint } from 'cloudflare:workers';
import { Hono } from 'hono';
import { authenticateToken } from './auth';

export { UserSessionDO } from './do/user-session-do';

const app = new Hono<{ Bindings: Env }>();

app.get('/health', c => c.json({ ok: true }));

app.get('/connect', async c => {
  const token = c.req.query('token') ?? null;
  const auth = await authenticateToken(token, c.env);
  if (!auth) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const doId = c.env.USER_SESSION_DO.idFromName(auth.userId);
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
}
