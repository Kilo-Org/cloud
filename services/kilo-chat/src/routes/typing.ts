import type { Hono } from 'hono';
import { z } from 'zod';
import type { AuthContext } from '../auth';

const ulidSchema = z.string().regex(/^[0-9A-Z]{26}$/, 'Invalid ULID');

export function registerTypingRoutes(app: Hono<{ Bindings: Env; Variables: AuthContext }>): void {
  app.post('/v1/conversations/:id/typing', async c => {
    const idParam = ulidSchema.safeParse(c.req.param('id'));
    if (!idParam.success) {
      return c.json({ error: 'Invalid conversation ID' }, 400);
    }
    const conversationId = idParam.data;
    const callerId = c.get('callerId');

    const convStub = c.env.CONVERSATION_DO.get(c.env.CONVERSATION_DO.idFromName(conversationId));

    const result = await convStub.setTyping(callerId);
    if (!result.ok) {
      return c.json({ error: 'Forbidden' }, 403);
    }

    return c.json({});
  });
}
