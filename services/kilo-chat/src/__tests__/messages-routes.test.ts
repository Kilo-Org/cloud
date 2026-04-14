import { env } from 'cloudflare:test';
import { describe, it, expect, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { createMiddleware } from 'hono/factory';
import type { AuthContext } from '../auth';
import { registerConversationRoutes } from '../routes/conversations';
import { registerMessageRoutes } from '../routes/messages';
import type { ConversationDO } from '../do/conversation-do';
import type { MembershipDO } from '../do/membership-do';

function makeApp(callerId: string, callerKind: 'user' | 'bot') {
  const mockAuth = createMiddleware<{ Bindings: Env; Variables: AuthContext }>(
    async (c, next) => {
      c.set('callerId', callerId);
      c.set('callerKind', callerKind);
      await next();
    }
  );

  const app = new Hono<{ Bindings: Env; Variables: AuthContext }>();
  app.use('/v1/*', mockAuth);
  registerConversationRoutes(app);
  registerMessageRoutes(app);
  return app;
}

function getConvStub(convId: string): DurableObjectStub<ConversationDO> {
  return env.CONVERSATION_DO.get(env.CONVERSATION_DO.idFromName(convId));
}

function getMemberStub(memberId: string): DurableObjectStub<MembershipDO> {
  return env.MEMBERSHIP_DO.get(env.MEMBERSHIP_DO.idFromName(memberId));
}

/**
 * Creates a fresh conversation for each test context.
 * Returns { conversationId, userId, botId, userApp, botApp }
 */
async function createConversation(userSuffix: string) {
  const userId = `user-${userSuffix}`;
  const sandboxId = `sandbox-${userSuffix}`;
  const botId = `bot:kiloclaw:${sandboxId}`;

  const userApp = makeApp(userId, 'user');
  const botApp = makeApp(botId, 'bot');

  const res = await userApp.request(
    '/v1/conversations',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sandboxId, title: `Chat ${userSuffix}` }),
    },
    env
  );

  expect(res.status).toBe(201);
  const { conversationId } = await res.json<{ conversationId: string }>();

  return { conversationId, userId, botId, sandboxId, userApp, botApp };
}

const sampleContent = [{ type: 'text', text: 'Hello world' }];

describe('POST /v1/messages', () => {
  it('creates a message and returns { messageId, version }', async () => {
    const { conversationId, userApp } = await createConversation('msg-create-1');

    const res = await userApp.request(
      '/v1/messages',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ conversationId, content: sampleContent }),
      },
      env
    );

    expect(res.status).toBe(201);
    const body = await res.json<{ messageId: string; version: number }>();
    expect(body.messageId).toBeTruthy();
    expect(typeof body.messageId).toBe('string');
    expect(body.version).toBe(1);
  });

  it('returns 403 for non-member', async () => {
    const { conversationId } = await createConversation('msg-create-nonmember');
    const strangerApp = makeApp('user-stranger-abc', 'user');

    const res = await strangerApp.request(
      '/v1/messages',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ conversationId, content: sampleContent }),
      },
      env
    );

    expect(res.status).toBe(403);
    const body = await res.json<{ error: string }>();
    expect(body.error).toBe('Forbidden');
  });

  it('returns 400 for invalid body', async () => {
    const { conversationId, userApp } = await createConversation('msg-create-invalid');

    const res = await userApp.request(
      '/v1/messages',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ conversationId }), // missing content
      },
      env
    );

    expect(res.status).toBe(400);
  });

  it('bot can also send messages to a conversation', async () => {
    const { conversationId, botApp } = await createConversation('msg-create-bot');

    const res = await botApp.request(
      '/v1/messages',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ conversationId, content: sampleContent }),
      },
      env
    );

    expect(res.status).toBe(201);
    const body = await res.json<{ messageId: string; version: number }>();
    expect(body.messageId).toBeTruthy();
    expect(body.version).toBe(1);
  });
});

describe('GET /v1/conversations/:id/messages', () => {
  it('returns messages in reverse chronological order', async () => {
    const { conversationId, userApp } = await createConversation('msg-list-1');

    // Create a few messages
    await userApp.request(
      '/v1/messages',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ conversationId, content: [{ type: 'text', text: 'First' }] }),
      },
      env
    );
    await userApp.request(
      '/v1/messages',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ conversationId, content: [{ type: 'text', text: 'Second' }] }),
      },
      env
    );
    await userApp.request(
      '/v1/messages',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ conversationId, content: [{ type: 'text', text: 'Third' }] }),
      },
      env
    );

    const res = await userApp.request(
      `/v1/conversations/${conversationId}/messages`,
      {},
      env
    );

    expect(res.status).toBe(200);
    const body = await res.json<{ messages: Array<{ id: string; content: string }> }>();
    expect(Array.isArray(body.messages)).toBe(true);
    expect(body.messages.length).toBe(3);
    // Should be in reverse chronological order (newest first — desc by id)
    expect(body.messages[0].id > body.messages[1].id).toBe(true);
    expect(body.messages[1].id > body.messages[2].id).toBe(true);
  });

  it('supports cursor pagination via ?before param', async () => {
    const { conversationId, userApp } = await createConversation('msg-list-paged');

    // Create 3 messages
    const msgIds: string[] = [];
    for (let i = 0; i < 3; i++) {
      const res = await userApp.request(
        '/v1/messages',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ conversationId, content: [{ type: 'text', text: `Msg ${i}` }] }),
        },
        env
      );
      const b = await res.json<{ messageId: string }>();
      msgIds.push(b.messageId);
    }

    // List with limit=2 (get first page — newest 2)
    const page1Res = await userApp.request(
      `/v1/conversations/${conversationId}/messages?limit=2`,
      {},
      env
    );
    expect(page1Res.status).toBe(200);
    const page1 = await page1Res.json<{ messages: Array<{ id: string }> }>();
    expect(page1.messages.length).toBe(2);

    // Paginate using cursor
    const cursor = page1.messages[page1.messages.length - 1].id;
    const page2Res = await userApp.request(
      `/v1/conversations/${conversationId}/messages?limit=2&before=${cursor}`,
      {},
      env
    );
    expect(page2Res.status).toBe(200);
    const page2 = await page2Res.json<{ messages: Array<{ id: string }> }>();
    expect(page2.messages.length).toBe(1);
    // All page2 ids should be less than cursor
    for (const msg of page2.messages) {
      expect(msg.id < cursor).toBe(true);
    }
  });

  it('returns 403 for non-member', async () => {
    const { conversationId } = await createConversation('msg-list-forbidden');
    const strangerApp = makeApp('user-stranger-list', 'user');

    const res = await strangerApp.request(
      `/v1/conversations/${conversationId}/messages`,
      {},
      env
    );

    expect(res.status).toBe(403);
  });
});

describe('PATCH /v1/messages/:id', () => {
  it('edits a message and returns { messageId, version }', async () => {
    const { conversationId, userApp } = await createConversation('msg-edit-1');

    // Create a message
    const createRes = await userApp.request(
      '/v1/messages',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ conversationId, content: sampleContent }),
      },
      env
    );
    const { messageId } = await createRes.json<{ messageId: string }>();

    // Edit the message
    const editRes = await userApp.request(
      `/v1/messages/${messageId}`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          conversationId,
          content: [{ type: 'text', text: 'Edited content' }],
          version: 2,
        }),
      },
      env
    );

    expect(editRes.status).toBe(200);
    const body = await editRes.json<{ messageId: string; version: number }>();
    expect(body.messageId).toBe(messageId);
    expect(body.version).toBe(2);
  });

  it('returns 409 on stale version (version <= current)', async () => {
    const { conversationId, userApp } = await createConversation('msg-edit-conflict');

    const createRes = await userApp.request(
      '/v1/messages',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ conversationId, content: sampleContent }),
      },
      env
    );
    const { messageId } = await createRes.json<{ messageId: string }>();

    // Try to edit with same version (version=1 is not greater than current=1)
    const editRes = await userApp.request(
      `/v1/messages/${messageId}`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          conversationId,
          content: [{ type: 'text', text: 'Stale edit' }],
          version: 1,
        }),
      },
      env
    );

    expect(editRes.status).toBe(409);
  });

  it('returns 403 when non-sender tries to edit', async () => {
    const { conversationId, userId, botId, botApp } = await createConversation('msg-edit-forbidden');
    const userApp = makeApp(userId, 'user');

    // User creates a message
    const createRes = await userApp.request(
      '/v1/messages',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ conversationId, content: sampleContent }),
      },
      env
    );
    const { messageId } = await createRes.json<{ messageId: string }>();

    // Bot tries to edit user's message
    const editRes = await botApp.request(
      `/v1/messages/${messageId}`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          conversationId,
          content: [{ type: 'text', text: 'Bot edit attempt' }],
          version: 2,
        }),
      },
      env
    );

    expect(editRes.status).toBe(403);
  });
});

describe('DELETE /v1/messages/:id', () => {
  it('soft-deletes a message and returns 204', async () => {
    const { conversationId, userApp } = await createConversation('msg-delete-1');

    // Create a message
    const createRes = await userApp.request(
      '/v1/messages',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ conversationId, content: sampleContent }),
      },
      env
    );
    const { messageId } = await createRes.json<{ messageId: string }>();

    // Delete it
    const deleteRes = await userApp.request(
      `/v1/messages/${messageId}`,
      {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ conversationId }),
      },
      env
    );

    expect(deleteRes.status).toBe(204);

    // Verify message is soft-deleted (appears in list but marked deleted)
    const convStub = getConvStub(conversationId);
    const listResult = await convStub.listMessages({ limit: 10 });
    const deletedMsg = listResult.messages.find(m => m.id === messageId);
    expect(deletedMsg).toBeDefined();
    expect(deletedMsg!.deleted).toBe(true);
  });

  it('returns 403 when non-sender tries to delete', async () => {
    const { conversationId, userId, botId, botApp } = await createConversation('msg-delete-forbidden');
    const userApp = makeApp(userId, 'user');

    // User creates a message
    const createRes = await userApp.request(
      '/v1/messages',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ conversationId, content: sampleContent }),
      },
      env
    );
    const { messageId } = await createRes.json<{ messageId: string }>();

    // Bot tries to delete user's message
    const deleteRes = await botApp.request(
      `/v1/messages/${messageId}`,
      {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ conversationId }),
      },
      env
    );

    expect(deleteRes.status).toBe(403);
  });

  it('returns 404 for non-existent message', async () => {
    const { conversationId, userApp } = await createConversation('msg-delete-notfound');

    const deleteRes = await userApp.request(
      '/v1/messages/01ARZ3NDEKTSV4RRFFQ69G5FAV',
      {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ conversationId }),
      },
      env
    );

    expect(deleteRes.status).toBe(404);
  });
});

describe('Webhook queue enqueue', () => {
  it('does not error when a human sends a message to a conversation with a bot member', async () => {
    const { conversationId, userApp } = await createConversation('msg-webhook-1');

    // This should succeed without errors — the webhook queue send happens via waitUntil
    const res = await userApp.request(
      '/v1/messages',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ conversationId, content: sampleContent }),
      },
      env
    );

    expect(res.status).toBe(201);
    const body = await res.json<{ messageId: string; version: number }>();
    expect(body.messageId).toBeTruthy();
  });
});
