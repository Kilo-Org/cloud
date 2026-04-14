import type { Hono } from 'hono';
import { z } from 'zod';
import type { AuthContext } from '../auth';

const contentBlockSchema = z.object({ type: z.string() }).passthrough();

const createMessageSchema = z.object({
  conversationId: z.string().min(1),
  content: z.array(contentBlockSchema).min(1),
  inReplyToMessageId: z.string().optional(),
});

const editMessageSchema = z.object({
  conversationId: z.string().min(1),
  content: z.array(contentBlockSchema).min(1),
  version: z.number().int().nonnegative(),
});

const deleteMessageSchema = z.object({
  conversationId: z.string().min(1),
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
    const { conversationId, content, inReplyToMessageId } = body.data;

    const convStub = c.env.CONVERSATION_DO.get(c.env.CONVERSATION_DO.idFromName(conversationId));

    if (!(await convStub.isMember(callerId))) {
      return c.json({ error: 'Forbidden' }, 403);
    }

    const result = await convStub.createMessage({
      senderId: callerId,
      content,
      inReplyToMessageId,
    });

    if (!result.ok) {
      return c.json({ error: result.error }, 500);
    }

    const { messageId, version } = result;

    // Enqueue webhook if there are bot members that aren't the sender
    const botMembers = await convStub.getBotMembersExcluding(callerId);
    if (botMembers.length > 0) {
      const sendPromise = c.env.WEBHOOK_QUEUE.send({
        conversationId,
        messageId,
        from: callerId,
        content,
        sentAt: new Date().toISOString(),
      });
      try {
        c.executionCtx.waitUntil(sendPromise);
      } catch {
        // executionCtx may not be available in some contexts (e.g. tests)
        // fall through; queue send already initiated
      }
    }

    // Update lastMessageId on all members' MembershipDOs
    const info = await convStub.getInfo();
    if (info) {
      await Promise.all(
        info.members.map(member => {
          const stub = c.env.MEMBERSHIP_DO.get(c.env.MEMBERSHIP_DO.idFromName(member.id));
          return stub.updateLastMessageId(conversationId, messageId);
        })
      );
    }

    return c.json({ messageId, version }, 201);
  });

  // GET /v1/conversations/:id/messages — list messages
  app.get('/v1/conversations/:id/messages', async c => {
    const conversationId = c.req.param('id');
    const callerId = c.get('callerId');

    const convStub = c.env.CONVERSATION_DO.get(c.env.CONVERSATION_DO.idFromName(conversationId));

    if (!(await convStub.isMember(callerId))) {
      return c.json({ error: 'Forbidden' }, 403);
    }

    const beforeParam = c.req.query('before');
    const limitParam = c.req.query('limit');
    const limit = Math.min(limitParam ? parseInt(limitParam, 10) || 50 : 50, 100);

    const result = await convStub.listMessages({
      limit,
      before: beforeParam,
    });

    return c.json({ messages: result.messages });
  });

  // PATCH /v1/messages/:id — edit message
  app.patch('/v1/messages/:id', async c => {
    const messageId = c.req.param('id');
    const callerId = c.get('callerId');

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

    const { conversationId, content, version } = body.data;

    const convStub = c.env.CONVERSATION_DO.get(c.env.CONVERSATION_DO.idFromName(conversationId));

    if (!(await convStub.isMember(callerId))) {
      return c.json({ error: 'Forbidden' }, 403);
    }

    const result = await convStub.editMessage({
      messageId,
      senderId: callerId,
      content,
      version,
    });

    if (!result.ok) {
      if (result.error.includes('not the owner') || result.error.includes('is not the owner')) {
        return c.json({ error: 'Forbidden' }, 403);
      }
      if (result.error.includes('not found')) {
        return c.json({ error: 'Not found' }, 404);
      }
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
    const messageId = c.req.param('id');
    const callerId = c.get('callerId');

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

    const { conversationId } = body.data;

    const convStub = c.env.CONVERSATION_DO.get(c.env.CONVERSATION_DO.idFromName(conversationId));

    if (!(await convStub.isMember(callerId))) {
      return c.json({ error: 'Forbidden' }, 403);
    }

    const result = await convStub.deleteMessage({
      messageId,
      senderId: callerId,
    });

    if (!result.ok) {
      if (result.error.includes('not the owner') || result.error.includes('is not the owner')) {
        return c.json({ error: 'Forbidden' }, 403);
      }
      if (result.error.includes('not found')) {
        return c.json({ error: 'Not found' }, 404);
      }
      return c.json({ error: result.error }, 500);
    }

    return new Response(null, { status: 204 });
  });
}
