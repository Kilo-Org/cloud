import type { Hono } from 'hono';
import { z } from 'zod';
import type { AuthContext } from '../auth';
import { createMessageFor, deleteMessageFor, editMessageFor } from '../services/messages';

const ulidSchema = z.string().regex(/^[0-9A-Z]{26}$/, 'Invalid ULID');

const contentBlockSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string().min(1) }),
]);

const createMessageSchema = z.object({
  conversationId: z.string().min(1),
  content: z.array(contentBlockSchema).min(1),
  inReplyToMessageId: ulidSchema.optional(),
});

const editMessageSchema = z.object({
  conversationId: z.string().min(1),
  content: z.array(contentBlockSchema).min(1),
  version: z.number().int().nonnegative(),
});

const deleteMessageSchema = z.object({
  conversationId: z.string().min(1),
});

const listMessagesQuerySchema = z.object({
  before: ulidSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export function registerMessageRoutes(app: Hono<{ Bindings: Env; Variables: AuthContext }>): void {
  // POST /v1/messages — create message
  app.post('/v1/messages', async c => {
    let rawBody: unknown;
    try {
      rawBody = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON' }, 400);
    }

    const body = createMessageSchema.safeParse(rawBody);
    if (!body.success) {
      return c.json({ error: 'Invalid request', issues: body.error.issues }, 400);
    }

    const callerId = c.get('callerId');
    // c.executionCtx is a getter that throws in some test contexts — wrap in
    // a small shim the service calls only if it has work to defer.
    const schedule = (p: Promise<unknown>) => {
      try {
        c.executionCtx.waitUntil(p);
      } catch {
        // executionCtx unavailable (e.g. unit tests); drop the waitUntil.
      }
    };
    const result = await createMessageFor(c.env, callerId, body.data, { waitUntil: schedule });
    if (!result.ok) {
      if (result.code === 'forbidden') return c.json({ error: result.error }, 403);
      return c.json({ error: result.error }, 500);
    }
    return c.json({ messageId: result.messageId, version: result.version }, 201);
  });

  // GET /v1/conversations/:id/messages — list messages
  app.get('/v1/conversations/:id/messages', async c => {
    const idParam = ulidSchema.safeParse(c.req.param('id'));
    if (!idParam.success) {
      return c.json({ error: 'Invalid conversation ID' }, 400);
    }
    const conversationId = idParam.data;
    const callerId = c.get('callerId');

    const query = listMessagesQuerySchema.safeParse({
      before: c.req.query('before') || undefined,
      limit: c.req.query('limit') ?? 50,
    });
    if (!query.success) {
      return c.json({ error: 'Invalid query', issues: query.error.issues }, 400);
    }

    const convStub = c.env.CONVERSATION_DO.get(c.env.CONVERSATION_DO.idFromName(conversationId));

    if (!(await convStub.isMember(callerId))) {
      return c.json({ error: 'Forbidden' }, 403);
    }

    const result = await convStub.listMessages({
      limit: query.data.limit,
      before: query.data.before,
    });

    return c.json({ messages: result.messages });
  });

  // PATCH /v1/messages/:id — edit message
  app.patch('/v1/messages/:id', async c => {
    const messageIdParam = ulidSchema.safeParse(c.req.param('id'));
    if (!messageIdParam.success) {
      return c.json({ error: 'Invalid message ID' }, 400);
    }

    let rawBody: unknown;
    try {
      rawBody = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON' }, 400);
    }

    const body = editMessageSchema.safeParse(rawBody);
    if (!body.success) {
      return c.json({ error: 'Invalid request', issues: body.error.issues }, 400);
    }

    const callerId = c.get('callerId');
    const result = await editMessageFor(c.env, callerId, {
      ...body.data,
      messageId: messageIdParam.data,
    });
    if (!result.ok) {
      if (result.code === 'forbidden') return c.json({ error: result.error }, 403);
      if (result.code === 'not_found') return c.json({ error: result.error }, 404);
      return c.json({ error: result.error }, 500);
    }
    if (result.conflict) {
      return c.json(
        { error: 'Conflict', messageId: result.messageId, version: result.version },
        409
      );
    }
    return c.json({ messageId: result.messageId, version: result.version });
  });

  // DELETE /v1/messages/:id — soft delete
  app.delete('/v1/messages/:id', async c => {
    const messageIdParam = ulidSchema.safeParse(c.req.param('id'));
    if (!messageIdParam.success) {
      return c.json({ error: 'Invalid message ID' }, 400);
    }

    let rawBody: unknown;
    try {
      rawBody = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON' }, 400);
    }

    const body = deleteMessageSchema.safeParse(rawBody);
    if (!body.success) {
      return c.json({ error: 'Invalid request', issues: body.error.issues }, 400);
    }

    const callerId = c.get('callerId');
    const result = await deleteMessageFor(c.env, callerId, {
      conversationId: body.data.conversationId,
      messageId: messageIdParam.data,
    });
    if (!result.ok) {
      if (result.code === 'forbidden') return c.json({ error: result.error }, 403);
      if (result.code === 'not_found') return c.json({ error: result.error }, 404);
      return c.json({ error: result.error }, 500);
    }
    return new Response(null, { status: 204 });
  });
}
