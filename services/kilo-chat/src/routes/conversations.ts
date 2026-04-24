import type { Hono } from 'hono';
import { z } from 'zod';
import type { AuthContext } from '../auth';
import {
  createConversationFor,
  renameConversationFor,
  leaveConversationFor,
  markReadFor,
} from '../services/conversations';
import {
  ulidSchema,
  sandboxIdSchema,
  paginationQuerySchema,
  renameConversationSchema,
} from './schemas';

const createConversationSchema = z.object({
  sandboxId: sandboxIdSchema,
  title: z.string().max(200).optional(),
});

export function registerConversationRoutes(
  app: Hono<{ Bindings: Env; Variables: AuthContext }>
): void {
  // POST /v1/conversations — create
  app.post('/v1/conversations', async c => {
    const callerKind = c.get('callerKind');
    if (callerKind !== 'user') {
      return c.json({ error: 'Only users can create conversations' }, 403);
    }

    let rawBody: unknown;
    try {
      rawBody = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON' }, 400);
    }

    const body = createConversationSchema.safeParse(rawBody);
    if (!body.success) {
      return c.json({ error: 'Invalid request', issues: body.error.issues }, 400);
    }

    const callerId = c.get('callerId');

    const result = await createConversationFor(c.env, callerId, body.data);
    if (!result.ok) {
      if (result.code === 'forbidden') return c.json({ error: result.error }, 403);
      return c.json({ error: result.error }, 500);
    }

    return c.json({ conversationId: result.conversationId }, 201);
  });

  // GET /v1/conversations — list my conversations, optionally filtered by sandboxId
  app.get('/v1/conversations', async c => {
    const callerId = c.get('callerId');

    let sandboxId: string | undefined;
    const rawSandboxId = c.req.query('sandboxId');
    if (rawSandboxId !== undefined) {
      const sbx = sandboxIdSchema.safeParse(rawSandboxId);
      if (!sbx.success) {
        return c.json({ error: 'Invalid sandboxId', issues: sbx.error.issues }, 400);
      }
      sandboxId = sbx.data;
    }

    const query = paginationQuerySchema.safeParse({
      limit: c.req.query('limit'),
      offset: c.req.query('offset'),
    });
    if (!query.success) {
      return c.json({ error: 'Invalid query parameters', issues: query.error.issues }, 400);
    }
    const { limit, offset } = query.data;

    const stub = c.env.MEMBERSHIP_DO.get(c.env.MEMBERSHIP_DO.idFromName(callerId));
    const { conversations, hasMore } = await stub.listConversations(sandboxId, limit, offset);
    return c.json({ conversations, hasMore, limit, offset });
  });

  // GET /v1/conversations/:id — get conversation details
  app.get('/v1/conversations/:id', async c => {
    const idParam = ulidSchema.safeParse(c.req.param('id'));
    if (!idParam.success) {
      return c.json({ error: 'Invalid conversation ID' }, 400);
    }
    const conversationId = idParam.data;
    const callerId = c.get('callerId');
    const stub = c.env.CONVERSATION_DO.get(c.env.CONVERSATION_DO.idFromName(conversationId));

    if (!(await stub.isMember(callerId))) {
      return c.json({ error: 'Forbidden' }, 403);
    }

    const info = await stub.getInfo();
    if (!info) {
      return c.json({ error: 'Not found' }, 404);
    }
    return c.json(info);
  });

  // PATCH /v1/conversations/:id — rename
  app.patch('/v1/conversations/:id', async c => {
    const idParam = ulidSchema.safeParse(c.req.param('id'));
    if (!idParam.success) {
      return c.json({ error: 'Invalid conversation ID' }, 400);
    }
    const conversationId = idParam.data;

    let rawBody: unknown;
    try {
      rawBody = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON' }, 400);
    }

    const body = renameConversationSchema.safeParse(rawBody);
    if (!body.success) {
      return c.json({ error: 'Invalid request', issues: body.error.issues }, 400);
    }

    const callerId = c.get('callerId');
    const result = await renameConversationFor(c.env, callerId, {
      conversationId,
      title: body.data.title,
    });
    if (!result.ok) {
      return c.json({ error: result.error }, 403);
    }

    return c.json({ ok: true });
  });

  // POST /v1/conversations/:id/leave — leave conversation
  app.post('/v1/conversations/:id/leave', async c => {
    const callerKind = c.get('callerKind');
    if (callerKind !== 'user') {
      return c.json({ error: 'Only users can leave conversations' }, 403);
    }

    const idParam = ulidSchema.safeParse(c.req.param('id'));
    if (!idParam.success) {
      return c.json({ error: 'Invalid conversation ID' }, 400);
    }
    const conversationId = idParam.data;

    const callerId = c.get('callerId');
    const result = await leaveConversationFor(c.env, callerId, { conversationId });
    if (!result.ok) {
      return c.json({ error: result.error }, 403);
    }

    return c.body(null, 204);
  });

  // POST /v1/conversations/:id/mark-read — mark conversation as read
  app.post('/v1/conversations/:id/mark-read', async c => {
    const idParam = ulidSchema.safeParse(c.req.param('id'));
    if (!idParam.success) {
      return c.json({ error: 'Invalid conversation ID' }, 400);
    }
    const conversationId = idParam.data;

    const callerId = c.get('callerId');
    const result = await markReadFor(c.env, callerId, { conversationId });
    if (!result.ok) {
      return c.json({ error: result.error }, 403);
    }

    return c.body(null, 204);
  });
}
