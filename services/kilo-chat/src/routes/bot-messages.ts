import type { Hono } from 'hono';
import { z } from 'zod';
import type { AuthContext } from '../auth';
import { createMessageFor, deleteMessageFor, editMessageFor } from '../services/messages';
import { addReactionFor, removeReactionFor } from '../services/reactions';
import { setTypingFor } from '../services/typing';

const ulidSchema = z.string().regex(/^[0-9A-Z]{26}$/, 'Invalid ULID');

const contentBlockSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string().min(1).max(8000) }),
]);

const createMessageSchema = z.object({
  conversationId: z.string().min(1),
  content: z.array(contentBlockSchema).min(1).max(20),
  inReplyToMessageId: ulidSchema.optional(),
});

const editMessageSchema = z.object({
  conversationId: z.string().min(1),
  content: z.array(contentBlockSchema).min(1).max(20),
  version: z.number().int().nonnegative(),
});

const deleteMessageSchema = z.object({
  conversationId: z.string().min(1),
});

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

const reactionBodySchema = z.object({
  conversationId: z.string().min(1),
  emoji: emojiSchema,
});

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
