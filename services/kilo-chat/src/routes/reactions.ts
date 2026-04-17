import type { Hono } from 'hono';
import type { AuthContext } from '../auth';
import { addReactionFor, removeReactionFor } from '../services/reactions';
import { ulidSchema, reactionBodySchema as bodySchema } from './schemas';

export function registerReactionsRoutes(
  app: Hono<{ Bindings: Env; Variables: AuthContext }>
): void {
  app.post('/v1/messages/:id/reactions', async c => {
    const msgIdParam = ulidSchema.safeParse(c.req.param('id'));
    if (!msgIdParam.success) return c.json({ error: 'Invalid message ID' }, 400);

    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON' }, 400);
    }
    const body = bodySchema.safeParse(raw);
    if (!body.success) {
      return c.json({ error: 'Invalid request', issues: body.error.issues }, 400);
    }

    const callerId = c.get('callerId');
    const result = await addReactionFor(c.env, callerId, {
      conversationId: body.data.conversationId,
      messageId: msgIdParam.data,
      emoji: body.data.emoji,
    });
    if (!result.ok) {
      if (result.code === 'forbidden') return c.json({ error: result.error }, 403);
      return c.json({ error: result.error }, 500);
    }
    return c.json({ id: result.id }, result.added ? 201 : 200);
  });

  app.delete('/v1/messages/:id/reactions', async c => {
    const msgIdParam = ulidSchema.safeParse(c.req.param('id'));
    if (!msgIdParam.success) return c.json({ error: 'Invalid message ID' }, 400);

    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON' }, 400);
    }
    const body = bodySchema.safeParse(raw);
    if (!body.success) {
      return c.json({ error: 'Invalid request', issues: body.error.issues }, 400);
    }

    const callerId = c.get('callerId');
    const result = await removeReactionFor(c.env, callerId, {
      conversationId: body.data.conversationId,
      messageId: msgIdParam.data,
      emoji: body.data.emoji,
    });
    if (!result.ok) {
      if (result.code === 'forbidden') return c.json({ error: result.error }, 403);
      return c.json({ error: result.error }, 500);
    }
    return new Response(null, { status: 204 });
  });
}
