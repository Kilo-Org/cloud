import type { Hono } from 'hono';
import { z } from 'zod';
import type { AuthContext } from '../auth';
import { setTypingFor } from '../services/typing';

const ulidSchema = z.string().regex(/^[0-9A-Z]{26}$/, 'Invalid ULID');

export function registerTypingRoutes(app: Hono<{ Bindings: Env; Variables: AuthContext }>): void {
  app.post('/v1/conversations/:id/typing', async c => {
    const idParam = ulidSchema.safeParse(c.req.param('id'));
    if (!idParam.success) {
      return c.json({ error: 'Invalid conversation ID' }, 400);
    }
    const callerId = c.get('callerId');
    const result = await setTypingFor(c.env, callerId, { conversationId: idParam.data });
    if (!result.ok) {
      return c.json({ error: result.error }, 403);
    }
    return c.json({});
  });
}
