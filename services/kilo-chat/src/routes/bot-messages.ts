import type { Hono } from 'hono';
import type { AuthContext } from '../auth';
import { createMessageFor, deleteMessageFor, editMessageFor } from '../services/messages';
import { addReactionFor, removeReactionFor } from '../services/reactions';
import { setTypingFor } from '../services/typing';
import {
  ulidSchema,
  createMessageSchema,
  editMessageSchema,
  deleteMessageSchema,
  reactionBodySchema,
} from './schemas';

export function registerBotRoutes(app: Hono<{ Bindings: Env; Variables: AuthContext }>): void {
  // POST /bot/v1/sandboxes/:sandboxId/messages — create message
  app.post('/bot/v1/sandboxes/:sandboxId/messages', async c => {
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

  // PATCH /bot/v1/sandboxes/:sandboxId/messages/:messageId — edit message
  app.patch('/bot/v1/sandboxes/:sandboxId/messages/:messageId', async c => {
    const messageIdParam = ulidSchema.safeParse(c.req.param('messageId'));
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

  // DELETE /bot/v1/sandboxes/:sandboxId/messages/:messageId — soft delete
  app.delete('/bot/v1/sandboxes/:sandboxId/messages/:messageId', async c => {
    const messageIdParam = ulidSchema.safeParse(c.req.param('messageId'));
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

  // POST /bot/v1/sandboxes/:sandboxId/conversations/:conversationId/typing
  app.post('/bot/v1/sandboxes/:sandboxId/conversations/:conversationId/typing', async c => {
    const conversationId = c.req.param('conversationId');
    const callerId = c.get('callerId');
    const result = await setTypingFor(c.env, callerId, { conversationId });
    if (!result.ok) {
      return c.json({ error: result.error }, 403);
    }
    return new Response(null, { status: 204 });
  });

  // POST /bot/v1/sandboxes/:sandboxId/messages/:messageId/reactions — add reaction
  app.post('/bot/v1/sandboxes/:sandboxId/messages/:messageId/reactions', async c => {
    const msgIdParam = ulidSchema.safeParse(c.req.param('messageId'));
    if (!msgIdParam.success) return c.json({ error: 'Invalid message ID' }, 400);

    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON' }, 400);
    }
    const body = reactionBodySchema.safeParse(raw);
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

  // DELETE /bot/v1/sandboxes/:sandboxId/messages/:messageId/reactions — remove reaction
  app.delete('/bot/v1/sandboxes/:sandboxId/messages/:messageId/reactions', async c => {
    const msgIdParam = ulidSchema.safeParse(c.req.param('messageId'));
    if (!msgIdParam.success) return c.json({ error: 'Invalid message ID' }, 400);

    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON' }, 400);
    }
    const body = reactionBodySchema.safeParse(raw);
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
