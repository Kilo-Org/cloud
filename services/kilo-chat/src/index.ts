import { WorkerEntrypoint } from 'cloudflare:workers';
import { Hono } from 'hono';
import { authMiddleware } from './auth';
import type { AuthContext } from './auth';
import { registerConversationRoutes } from './routes/conversations';

export { MembershipDO } from './do/membership-do';
export { ConversationDO } from './do/conversation-do';

const app = new Hono<{ Bindings: Env; Variables: AuthContext }>();

app.get('/health', c => c.json({ ok: true }));

app.use('/v1/*', authMiddleware);
registerConversationRoutes(app);

export default class extends WorkerEntrypoint<Env> {
  async fetch(request: Request): Promise<Response> {
    return app.fetch(request, this.env, this.ctx);
  }
}
