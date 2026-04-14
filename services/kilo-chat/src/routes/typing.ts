import type { Hono } from 'hono';
import type { AuthContext } from '../auth';

export function registerTypingRoutes(app: Hono<{ Bindings: Env; Variables: AuthContext }>): void {
  app.post('/v1/conversations/:id/typing', async c => {
    const conversationId = c.req.param('id');
    const callerId = c.get('callerId');

    const convStub = c.env.CONVERSATION_DO.get(c.env.CONVERSATION_DO.idFromName(conversationId));

    const result = await convStub.setTyping(callerId);
    if (!result.ok) {
      return c.json({ error: 'Forbidden' }, 403);
    }

    return c.json({});
  });
}
