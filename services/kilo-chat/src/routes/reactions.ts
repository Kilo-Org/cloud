import type { Hono } from 'hono';
import { z } from 'zod';
import type { AuthContext } from '../auth';

const ulidSchema = z.string().regex(/^[0-9A-Z]{26}$/, 'Invalid ULID');

// 1-64 bytes UTF-8, no C0 (0x00-0x1F) or C1 (0x7F-0x9F) control chars.
const emojiSchema = z
  .string()
  .min(1, 'emoji required')
  .refine(v => new TextEncoder().encode(v).length <= 64, { message: 'emoji too long' })
  .refine(
    v => {
      for (let i = 0; i < v.length; i++) {
        const c = v.charCodeAt(i);
        if ((c >= 0x00 && c <= 0x1f) || (c >= 0x7f && c <= 0x9f)) return false;
      }
      return true;
    },
    { message: 'emoji contains control chars' }
  );

const bodySchema = z.object({
  conversationId: z.string().min(1),
  emoji: emojiSchema,
});

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
    const { conversationId, emoji } = body.data;
    const stub = c.env.CONVERSATION_DO.get(c.env.CONVERSATION_DO.idFromName(conversationId));
    if (!(await stub.isMember(callerId))) return c.json({ error: 'Forbidden' }, 403);

    const result = await stub.addReaction({
      messageId: msgIdParam.data,
      memberId: callerId,
      emoji,
    });
    if (!result.ok) {
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
    const { conversationId, emoji } = body.data;
    const stub = c.env.CONVERSATION_DO.get(c.env.CONVERSATION_DO.idFromName(conversationId));
    if (!(await stub.isMember(callerId))) return c.json({ error: 'Forbidden' }, 403);

    const result = await stub.removeReaction({
      messageId: msgIdParam.data,
      memberId: callerId,
      emoji,
    });
    if (!result.ok) {
      return c.json({ error: result.error }, 500);
    }
    return new Response(null, { status: 204 });
  });
}
