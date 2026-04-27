import type { Hono } from 'hono';
import type { AuthContext } from '../auth';
import type {
  CreateConversationResponse,
  ConversationListResponse,
  ConversationDetailResponse,
  OkResponse,
} from '@kilocode/kilo-chat';
import { withDORetry } from '@kilocode/worker-utils';
import {
  createConversationFor,
  renameConversationFor,
  leaveConversationFor,
  markReadFor,
} from '../services/conversations';
import {
  ulidSchema,
  createConversationRequestSchema,
  listConversationsQuerySchema,
  renameConversationRequestSchema,
  decodeConversationCursor,
} from '@kilocode/kilo-chat';
import { makeSchedule } from './handler';

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

    const body = createConversationRequestSchema.safeParse(rawBody);
    if (!body.success) {
      return c.json({ error: 'Invalid request', issues: body.error.issues }, 400);
    }

    const callerId = c.get('callerId');

    const result = await createConversationFor(c.env, callerId, body.data);
    if (!result.ok) {
      if (result.code === 'forbidden') return c.json({ error: result.error }, 403);
      return c.json({ error: result.error }, 500);
    }

    return c.json(
      { conversationId: result.conversationId } satisfies CreateConversationResponse,
      201
    );
  });

  // GET /v1/conversations — list my conversations, optionally filtered by sandboxId
  app.get('/v1/conversations', async c => {
    const callerId = c.get('callerId');

    const query = listConversationsQuerySchema.safeParse({
      sandboxId: c.req.query('sandboxId'),
      limit: c.req.query('limit'),
      cursor: c.req.query('cursor'),
    });
    if (!query.success) {
      return c.json({ error: 'Invalid query parameters', issues: query.error.issues }, 400);
    }
    const { sandboxId, limit, cursor: cursorRaw } = query.data;
    const cursor = cursorRaw ? decodeConversationCursor(cursorRaw) : null;
    if (cursorRaw && !cursor) {
      return c.json({ error: 'Invalid cursor' }, 400);
    }

    const { conversations, hasMore, nextCursor } = await withDORetry(
      () => c.env.MEMBERSHIP_DO.get(c.env.MEMBERSHIP_DO.idFromName(callerId)),
      stub => stub.listConversations({ sandboxId, limit, cursor }),
      'MembershipDO.listConversations'
    );
    return c.json({ conversations, hasMore, nextCursor } satisfies ConversationListResponse);
  });

  // GET /v1/conversations/:id — get conversation details
  app.get('/v1/conversations/:id', async c => {
    const idParam = ulidSchema.safeParse(c.req.param('id'));
    if (!idParam.success) {
      return c.json({ error: 'Invalid conversation ID' }, 400);
    }
    const conversationId = idParam.data;
    const callerId = c.get('callerId');

    // Single RPC: getInfo returns members, so we check membership from the result.
    const info = await withDORetry(
      () => c.env.CONVERSATION_DO.get(c.env.CONVERSATION_DO.idFromName(conversationId)),
      stub => stub.getInfo(),
      'ConversationDO.getInfo'
    );
    if (!info || !info.members.some(m => m.id === callerId)) {
      return c.json({ error: 'Forbidden' }, 403);
    }
    return c.json(info satisfies ConversationDetailResponse);
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

    const body = renameConversationRequestSchema.safeParse(rawBody);
    if (!body.success) {
      return c.json({ error: 'Invalid request', issues: body.error.issues }, 400);
    }

    const callerId = c.get('callerId');
    const result = await renameConversationFor(
      c.env,
      callerId,
      {
        conversationId,
        title: body.data.title,
      },
      makeSchedule(c)
    );
    if (!result.ok) {
      return c.json({ error: result.error }, 403);
    }

    return c.json({ ok: true } satisfies OkResponse);
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
    const result = await leaveConversationFor(c.env, callerId, { conversationId }, makeSchedule(c));
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
    const result = await markReadFor(c.env, callerId, { conversationId }, makeSchedule(c));
    if (!result.ok) {
      return c.json({ error: result.error }, 403);
    }

    return c.body(null, 204);
  });
}
