import { Hono } from 'hono';
import { z } from 'zod';
import { ulid } from '../lib/ulid';
import type { AuthContext } from '../auth';

const createConversationSchema = z.object({
  sandboxId: z.string().min(1),
  title: z.string().optional(),
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
    const conversationId = ulid();
    const now = Date.now();
    const botId = `bot:kiloclaw:${body.data.sandboxId}`;

    // Initialize ConversationDO
    const convStub = c.env.CONVERSATION_DO.get(c.env.CONVERSATION_DO.idFromName(conversationId));
    await convStub.initialize({
      id: conversationId,
      title: body.data.title ?? null,
      createdBy: callerId,
      createdAt: now,
      members: [
        { id: callerId, kind: 'user' },
        { id: botId, kind: 'bot' },
      ],
    });

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
    const conversationId = c.req.param('id');
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
}
