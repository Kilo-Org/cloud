import type { Hono } from 'hono';
import { z } from 'zod';
import { ulid } from 'ulid';
import type { AuthContext } from '../auth';

const ulidSchema = z.string().regex(/^[0-9A-Z]{26}$/, 'Invalid ULID');

const SANDBOX_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

const createConversationSchema = z.object({
  sandboxId: z.string().regex(SANDBOX_ID_PATTERN, 'Invalid sandboxId'),
  title: z.string().max(200).optional(),
});

const renameConversationSchema = z.object({
  title: z.string().min(1).max(200),
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
    const allowedSandboxIds = c.get('allowedSandboxIds');
    if (!allowedSandboxIds.includes(body.data.sandboxId)) {
      return c.json({ error: 'You do not have access to this sandbox' }, 403);
    }

    const conversationId = ulid();
    const now = Date.now();
    const botId = `bot:kiloclaw:${body.data.sandboxId}`;

    // Initialize ConversationDO
    const convStub = c.env.CONVERSATION_DO.get(c.env.CONVERSATION_DO.idFromName(conversationId));
    const initResult = await convStub.initialize({
      id: conversationId,
      title: body.data.title ?? null,
      createdBy: callerId,
      createdAt: now,
      members: [
        { id: callerId, kind: 'user' },
        { id: botId, kind: 'bot' },
      ],
    });

    if (!initResult.ok) {
      return c.json({ error: 'Failed to initialize conversation' }, 500);
    }

    // Update MembershipDOs for both members
    const memberParams = {
      conversationId,
      conversationTitle: body.data.title ?? null,
      joinedAt: now,
    };

    const userMembership = c.env.MEMBERSHIP_DO.get(c.env.MEMBERSHIP_DO.idFromName(callerId));
    const botMembership = c.env.MEMBERSHIP_DO.get(c.env.MEMBERSHIP_DO.idFromName(botId));
    await Promise.all([
      userMembership.addConversation(memberParams),
      botMembership.addConversation(memberParams),
    ]);

    return c.json({ conversationId }, 201);
  });

  // GET /v1/conversations — list my conversations
  app.get('/v1/conversations', async c => {
    const callerId = c.get('callerId');
    const stub = c.env.MEMBERSHIP_DO.get(c.env.MEMBERSHIP_DO.idFromName(callerId));
    const list = await stub.listConversations();
    return c.json({ conversations: list });
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
    const callerKind = c.get('callerKind');
    if (callerKind !== 'user') {
      return c.json({ error: 'Only users can rename conversations' }, 403);
    }

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
    const convStub = c.env.CONVERSATION_DO.get(c.env.CONVERSATION_DO.idFromName(conversationId));

    if (!(await convStub.isMember(callerId))) {
      return c.json({ error: 'Forbidden' }, 403);
    }

    await convStub.updateTitle(body.data.title);

    const info = await convStub.getInfo();
    if (info) {
      await Promise.all(
        info.members.map(member => {
          const memberStub = c.env.MEMBERSHIP_DO.get(c.env.MEMBERSHIP_DO.idFromName(member.id));
          return memberStub.updateConversationTitle(conversationId, body.data.title);
        })
      );
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
    const convStub = c.env.CONVERSATION_DO.get(c.env.CONVERSATION_DO.idFromName(conversationId));

    if (!(await convStub.isMember(callerId))) {
      return c.json({ error: 'Forbidden' }, 403);
    }

    // Soft-leave: mark member as left in ConversationDO (preserves FK integrity)
    const { remainingUsers, botMembers } = await convStub.leaveMember(callerId);

    // Remove conversation from the caller's membership index
    const callerMembership = c.env.MEMBERSHIP_DO.get(c.env.MEMBERSHIP_DO.idFromName(callerId));
    await callerMembership.removeConversation(conversationId);

    // If no users remain, clean up bot memberships too
    if (remainingUsers.length === 0) {
      await Promise.all(
        botMembers.map(member => {
          const memberStub = c.env.MEMBERSHIP_DO.get(c.env.MEMBERSHIP_DO.idFromName(member.id));
          return memberStub.removeConversation(conversationId);
        })
      );
    }

    return c.body(null, 204);
  });
}
