import { env } from 'cloudflare:test';
import { describe, it, expect, vi } from 'vitest';
import { ulidToTimestamp } from '@kilocode/kilo-chat';
import { badgeBucketForConversation } from '@kilocode/notifications';
import { ulid } from 'ulid';
import type { ConversationDO } from '../do/conversation-do';
import { postCommitFanOut } from '../services/messages';
import { makeApp } from './helpers';

function getConvStub(convId: string): DurableObjectStub<ConversationDO> {
  return env.CONVERSATION_DO.get(env.CONVERSATION_DO.idFromName(convId));
}

// Test-only recording surface added to the miniflare `kiloclaw-stub` worker
// (see vitest.config.mts). The stub buffers every `deliverChatWebhook` call
// in module scope; tests read and reset the buffer through these RPCs.
type RecordingKiloclaw = typeof env.KILOCLAW & {
  __recordedWebhookCalls(): Promise<Array<Record<string, unknown>>>;
  __clearWebhookCalls(): Promise<void>;
};
const recordingKiloclaw = env.KILOCLAW as RecordingKiloclaw;

type RecordingNotifications = typeof env.NOTIFICATIONS & {
  __incrementBadgeBucket(input: {
    userId: string;
    badgeBucket: string;
    delta: number;
  }): Promise<void>;
  __listNonZeroBuckets(userId: string): Promise<Array<{ badgeBucket: string; badgeCount: number }>>;
};
const recordingNotifications = env.NOTIFICATIONS as RecordingNotifications;

async function waitForWebhookCalls(
  predicate: (calls: Array<Record<string, unknown>>) => boolean,
  timeoutMs = 2000
): Promise<Array<Record<string, unknown>>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const calls = await recordingKiloclaw.__recordedWebhookCalls();
    if (predicate(calls)) return calls;
    if (Date.now() > deadline) {
      throw new Error(
        `Timed out waiting on deliverChatWebhook; last calls: ${JSON.stringify(calls)}`
      );
    }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
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

async function createMultiHumanConversation(userSuffix: string) {
  const userId = `user-${userSuffix}`;
  const recipientId = `recipient-${userSuffix}`;
  const sandboxId = `sandbox-${userSuffix}`;
  const botId = `bot:kiloclaw:${sandboxId}`;
  const conversationId = ulid();
  const joinedAt = Date.now();
  const members: Array<{ id: string; kind: 'user' | 'bot' }> = [
    { id: userId, kind: 'user' },
    { id: recipientId, kind: 'user' },
    { id: botId, kind: 'bot' },
  ];

  const convStub = getConvStub(conversationId);
  const initResult = await convStub.initialize({
    id: conversationId,
    title: `Chat ${userSuffix}`,
    createdBy: userId,
    createdAt: joinedAt,
    members,
  });
  expect(initResult).toEqual({ ok: true });

  for (const member of members) {
    await env.MEMBERSHIP_DO.get(env.MEMBERSHIP_DO.idFromName(member.id)).addConversation({
      conversationId,
      title: `Chat ${userSuffix}`,
      sandboxId,
      joinedAt,
    });
  }

  const deliveredEventService = {
    fetch: env.EVENT_SERVICE.fetch.bind(env.EVENT_SERVICE),
    connect: env.EVENT_SERVICE.connect.bind(env.EVENT_SERVICE),
    pushEvent: async () => true,
  } satisfies Env['EVENT_SERVICE'];

  return {
    conversationId,
    userId,
    recipientId,
    sandboxId,
    userApp: makeApp(userId, 'user'),
    recipientApp: makeApp(recipientId, 'user'),
    deliveredEnv: { ...env, EVENT_SERVICE: deliveredEventService } satisfies Env,
  };
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
    const body = await res.json<{ messageId: string }>();
    expect(body.messageId).toBeTruthy();
    expect(typeof body.messageId).toBe('string');
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

  it('returns 400 when conversationId is not a valid ULID', async () => {
    const { userApp } = await createConversation('msg-create-bad-convid');

    const res = await userApp.request(
      '/v1/messages',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          conversationId: 'not-a-ulid',
          content: [{ type: 'text', text: 'Hello' }],
        }),
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
    const body = await res.json<{ messageId: string }>();
    expect(body.messageId).toBeTruthy();
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

    const res = await userApp.request(`/v1/conversations/${conversationId}/messages`, {}, env);

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
    const page1 = await page1Res.json<{
      messages: Array<{ id: string }>;
      hasMore: boolean;
      nextCursor: string | null;
    }>();
    expect(page1.messages.length).toBe(2);
    expect(page1.hasMore).toBe(true);
    expect(page1.nextCursor).toBe(page1.messages[1]?.id);

    // Paginate using cursor
    const cursor = page1.nextCursor;
    expect(cursor).not.toBeNull();
    const page2Res = await userApp.request(
      `/v1/conversations/${conversationId}/messages?limit=2&before=${cursor}`,
      {},
      env
    );
    expect(page2Res.status).toBe(200);
    const page2 = await page2Res.json<{
      messages: Array<{ id: string }>;
      hasMore: boolean;
      nextCursor: string | null;
    }>();
    expect(page2.messages.length).toBe(1);
    expect(page2.hasMore).toBe(false);
    expect(page2.nextCursor).toBeNull();
    // All page2 ids should be less than cursor
    for (const msg of page2.messages) {
      expect(cursor && msg.id < cursor).toBe(true);
    }
  });

  it('returns 403 for non-member', async () => {
    const { conversationId } = await createConversation('msg-list-forbidden');
    const strangerApp = makeApp('user-stranger-list', 'user');

    const res = await strangerApp.request(`/v1/conversations/${conversationId}/messages`, {}, env);

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

    const editRes = await userApp.request(
      `/v1/messages/${messageId}`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          conversationId,
          content: [{ type: 'text', text: 'Edited content' }],
          timestamp: Date.now(),
        }),
      },
      env
    );

    expect(editRes.status).toBe(200);
    const body = await editRes.json<{ messageId: string }>();
    expect(body.messageId).toBe(messageId);
  });

  it('discards stale edit (older timestamp)', async () => {
    const { conversationId, userApp } = await createConversation('msg-edit-stale');

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

    // First edit with timestamp 1000
    await userApp.request(
      `/v1/messages/${messageId}`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          conversationId,
          content: [{ type: 'text', text: 'Edit 1' }],
          timestamp: 1000,
        }),
      },
      env
    );

    // Second edit with older timestamp — should be rejected as conflict
    const editRes = await userApp.request(
      `/v1/messages/${messageId}`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          conversationId,
          content: [{ type: 'text', text: 'Stale edit' }],
          timestamp: 500,
        }),
      },
      env
    );

    expect(editRes.status).toBe(409);
  });

  it('returns 400 when edit content includes caller-supplied action resolution', async () => {
    const { conversationId, userApp } = await createConversation('msg-edit-resolved-actions');

    const editRes = await userApp.request(
      '/v1/messages/01ARZ3NDEKTSV4RRFFQ69G5FAV',
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          conversationId,
          content: [
            {
              type: 'actions',
              groupId: 'approval-1',
              actions: [],
              resolved: {
                value: 'deny',
                resolvedBy: 'user-1',
                resolvedAt: 1,
              },
            },
          ],
          timestamp: Date.now(),
        }),
      },
      env
    );

    expect(editRes.status).toBe(400);
  });

  it('returns 403 when non-sender tries to edit', async () => {
    const {
      conversationId,
      userId,
      botId: _botId,
      botApp,
    } = await createConversation('msg-edit-forbidden');
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
          timestamp: Date.now(),
        }),
      },
      env
    );

    expect(editRes.status).toBe(403);
  });

  it('returns 403 when a former member tries to edit their message', async () => {
    const { conversationId, userApp } = await createConversation('msg-edit-left');

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

    const leaveRes = await userApp.request(
      `/v1/conversations/${conversationId}/leave`,
      { method: 'POST' },
      env
    );
    expect(leaveRes.status).toBe(200);
    await expect(leaveRes.json()).resolves.toEqual({ ok: true });

    const editRes = await userApp.request(
      `/v1/messages/${messageId}`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          conversationId,
          content: [{ type: 'text', text: 'Edited after leaving' }],
          timestamp: Date.now(),
        }),
      },
      env
    );

    expect(editRes.status).toBe(403);
  });
});

describe('DELETE /v1/messages/:id', () => {
  it('soft-deletes a message and returns ok', async () => {
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

    // Delete it (conversationId goes in query string, not body)
    const delQs = new URLSearchParams({ conversationId });
    const deleteRes = await userApp.request(
      `/v1/messages/${messageId}?${delQs.toString()}`,
      {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
      },
      env
    );

    expect(deleteRes.status).toBe(200);
    await expect(deleteRes.json()).resolves.toEqual({ ok: true });

    // Verify message is soft-deleted (appears in list but marked deleted)
    const convStub = getConvStub(conversationId);
    const listResult = await convStub.listMessages({ limit: 10 });
    const deletedMsg = listResult.messages.find(m => m.id === messageId);
    expect(deletedMsg).toBeDefined();
    expect(deletedMsg!.deleted).toBe(true);
  });

  it('returns 403 when non-sender tries to delete', async () => {
    const {
      conversationId,
      userId,
      botId: _botId,
      botApp,
    } = await createConversation('msg-delete-forbidden');
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
    const delQs = new URLSearchParams({ conversationId });
    const deleteRes = await botApp.request(
      `/v1/messages/${messageId}?${delQs.toString()}`,
      {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
      },
      env
    );

    expect(deleteRes.status).toBe(403);
  });

  it('returns 403 when a former member tries to delete their message', async () => {
    const { conversationId, userApp } = await createConversation('msg-delete-left');

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

    const leaveRes = await userApp.request(
      `/v1/conversations/${conversationId}/leave`,
      { method: 'POST' },
      env
    );
    expect(leaveRes.status).toBe(200);
    await expect(leaveRes.json()).resolves.toEqual({ ok: true });

    const delQs = new URLSearchParams({ conversationId });
    const deleteRes = await userApp.request(
      `/v1/messages/${messageId}?${delQs.toString()}`,
      {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
      },
      env
    );

    expect(deleteRes.status).toBe(403);
  });

  it('returns 404 for non-existent message', async () => {
    const { conversationId, userApp } = await createConversation('msg-delete-notfound');

    const delQs = new URLSearchParams({ conversationId });
    const deleteRes = await userApp.request(
      `/v1/messages/01ARZ3NDEKTSV4RRFFQ69G5FAV?${delQs.toString()}`,
      {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
      },
      env
    );

    expect(deleteRes.status).toBe(404);
  });
});

describe('input size limits', () => {
  it('rejects message text exceeding max length', async () => {
    const { conversationId, userApp } = await createConversation('msg-size-text');

    const res = await userApp.request(
      '/v1/messages',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          conversationId,
          content: [{ type: 'text', text: 'x'.repeat(20_000) }],
        }),
      },
      env
    );

    expect(res.status).toBe(400);
  });

  it('rejects message with too many content blocks', async () => {
    const { conversationId, userApp } = await createConversation('msg-size-blocks');

    const blocks = Array.from({ length: 50 }, (_, i) => ({ type: 'text', text: `block ${i}` }));
    const res = await userApp.request(
      '/v1/messages',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ conversationId, content: blocks }),
      },
      env
    );

    expect(res.status).toBe(400);
  });

  it('rejects POST with whitespace-only text', async () => {
    const { conversationId, userApp } = await createConversation('msg-blank-text-post');
    for (const bad of ['', '   ', '\t\n ']) {
      const res = await userApp.request(
        '/v1/messages',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            conversationId,
            content: [{ type: 'text', text: bad }],
          }),
        },
        env
      );
      expect(res.status, `text ${JSON.stringify(bad)} should be rejected`).toBe(400);
    }
  });

  it('trims surrounding whitespace on POST', async () => {
    const { conversationId, userApp } = await createConversation('msg-trim-text-post');
    const res = await userApp.request(
      '/v1/messages',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          conversationId,
          content: [{ type: 'text', text: '  hello  ' }],
        }),
      },
      env
    );
    expect(res.status).toBe(201);
    const { messageId } = await res.json<{ messageId: string }>();

    // Read back the message and confirm it was stored trimmed
    const listRes = await userApp.request(
      `/v1/conversations/${conversationId}/messages?limit=10`,
      {},
      env
    );
    const body = await listRes.json<{
      messages: Array<{ id: string; content: Array<{ type: string; text?: string }> }>;
    }>();
    const stored = body.messages.find(m => m.id === messageId);
    expect(stored).toBeDefined();
    const textBlock = stored!.content[0];
    expect(textBlock.type).toBe('text');
    expect(textBlock.text).toBe('hello');
  });

  it('rejects PATCH with whitespace-only text', async () => {
    const { conversationId, userApp } = await createConversation('msg-blank-text-patch');
    // Seed a message first
    const seedRes = await userApp.request(
      '/v1/messages',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ conversationId, content: sampleContent }),
      },
      env
    );
    const { messageId } = await seedRes.json<{ messageId: string }>();

    for (const bad of ['', '   ', '\t\n ']) {
      const res = await userApp.request(
        `/v1/messages/${messageId}`,
        {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            conversationId,
            content: [{ type: 'text', text: bad }],
            timestamp: Date.now(),
          }),
        },
        env
      );
      expect(res.status, `text ${JSON.stringify(bad)} should be rejected`).toBe(400);
    }
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
    const body = await res.json<{ messageId: string }>();
    expect(body.messageId).toBeTruthy();
  });

  it('delivers webhooks to the bot in ConversationDO commit order', async () => {
    await recordingKiloclaw.__clearWebhookCalls();
    const { conversationId, userApp } = await createConversation('msg-webhook-order');

    const sentTexts: string[] = [];
    const sentIds: string[] = [];
    for (let i = 0; i < 5; i++) {
      const text = `msg-${i}`;
      sentTexts.push(text);
      const res = await userApp.request(
        '/v1/messages',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ conversationId, content: [{ type: 'text', text }] }),
        },
        env
      );
      expect(res.status).toBe(201);
      const { messageId } = await res.json<{ messageId: string }>();
      sentIds.push(messageId);
    }

    const calls = await waitForWebhookCalls(cs => cs.length >= sentTexts.length);
    const observedIds = calls
      .filter(c => c.conversationId === conversationId)
      .map(c => c.messageId as string);
    expect(observedIds).toEqual(sentIds);
  });
});

describe('Webhook reply context', () => {
  it('includes inReplyToBody and inReplyToSender when replying to an existing message', async () => {
    await recordingKiloclaw.__clearWebhookCalls();

    const userId = 'user-reply-context-1';
    const sandboxId = 'sandbox-reply-context-1';
    const userApp = makeApp(userId, 'user');

    // Create conversation
    const convRes = await userApp.request(
      '/v1/conversations',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sandboxId, title: 'Reply context test' }),
      },
      env
    );
    expect(convRes.status).toBe(201);
    const { conversationId } = await convRes.json<{ conversationId: string }>();

    // Create first message (the parent)
    const parentRes = await userApp.request(
      '/v1/messages',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          conversationId,
          content: [{ type: 'text', text: 'Parent message text' }],
        }),
      },
      env
    );
    expect(parentRes.status).toBe(201);
    const { messageId: parentMessageId } = await parentRes.json<{ messageId: string }>();

    // Create second message as a reply to the first
    const replyRes = await userApp.request(
      '/v1/messages',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          conversationId,
          content: [{ type: 'text', text: 'Reply message text' }],
          inReplyToMessageId: parentMessageId,
        }),
      },
      env
    );
    expect(replyRes.status).toBe(201);

    // Webhook delivery runs in the ConversationDO's waitUntil; poll the
    // recording stub for the reply call.
    const calls = await waitForWebhookCalls(cs =>
      cs.some(c => c.inReplyToMessageId === parentMessageId)
    );
    const replyCall = calls.find(c => c.inReplyToMessageId === parentMessageId);
    expect(replyCall).toMatchObject({
      inReplyToMessageId: parentMessageId,
      inReplyToBody: 'Parent message text',
      inReplyToSender: userId,
    });
  });

  it('delivers webhook without inReplyToBody or inReplyToSender when the parent message is deleted', async () => {
    await recordingKiloclaw.__clearWebhookCalls();

    const userId = 'user-reply-deleted-1';
    const sandboxId = 'sandbox-reply-deleted-1';
    const userApp = makeApp(userId, 'user');

    // Create conversation
    const convRes = await userApp.request(
      '/v1/conversations',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sandboxId, title: 'Reply deleted parent test' }),
      },
      env
    );
    expect(convRes.status).toBe(201);
    const { conversationId } = await convRes.json<{ conversationId: string }>();

    // Create parent message then delete it
    const parentRes = await userApp.request(
      '/v1/messages',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          conversationId,
          content: [{ type: 'text', text: 'This will be deleted' }],
        }),
      },
      env
    );
    expect(parentRes.status).toBe(201);
    const { messageId: deletedParentId } = await parentRes.json<{ messageId: string }>();

    const deleteQs = new URLSearchParams({ conversationId });
    await userApp.request(
      `/v1/messages/${deletedParentId}?${deleteQs.toString()}`,
      {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
      },
      env
    );

    // Drain the parent message's webhook then reset so only the reply call
    // remains visible to the assertion.
    await waitForWebhookCalls(cs => cs.some(c => c.messageId === deletedParentId));
    await recordingKiloclaw.__clearWebhookCalls();

    // Create message replying to the deleted parent
    const res = await userApp.request(
      '/v1/messages',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          conversationId,
          content: [{ type: 'text', text: 'Reply to deleted' }],
          inReplyToMessageId: deletedParentId,
        }),
      },
      env
    );
    expect(res.status).toBe(201);

    // Webhook should have been delivered without body/sender (parent was deleted).
    const calls = await waitForWebhookCalls(cs =>
      cs.some(c => c.inReplyToMessageId === deletedParentId)
    );
    const call = calls.find(c => c.inReplyToMessageId === deletedParentId);
    expect(call).toBeDefined();
    expect(call!.inReplyToBody).toBeUndefined();
    expect(call!.inReplyToSender).toBeUndefined();
  });
});

describe('sender conversation read state after sending', () => {
  it('marks sender conversation as read when they send a message', async () => {
    const { conversationId, userId, sandboxId, userApp } =
      await createConversation('msg-sender-unread');

    // Check initial state — both should be null
    const memberStub = env.MEMBERSHIP_DO.get(env.MEMBERSHIP_DO.idFromName(userId));
    const before = await memberStub.listConversations({ sandboxId });
    const convBefore = before.conversations.find(c => c.conversationId === conversationId);
    expect(convBefore).toBeDefined();
    expect(convBefore!.lastActivityAt).toBeNull();
    expect(convBefore!.lastReadAt).toBeNull();

    // User sends a message
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

    // Check sender's MembershipDO — both should be bumped
    const after = await memberStub.listConversations({ sandboxId });
    const convAfter = after.conversations.find(c => c.conversationId === conversationId);
    expect(convAfter).toBeDefined();
    expect(convAfter!.lastActivityAt).not.toBeNull();
    // Sender's lastReadAt is updated so the conversation doesn't look unread
    expect(convAfter!.lastReadAt).not.toBeNull();
    expect(convAfter!.lastReadAt).toBe(convAfter!.lastActivityAt);
  });
});

describe('recipient conversation read state after message delivery', () => {
  it('does not mark delivered recipient sockets as read without an explicit read call', async () => {
    const { conversationId, recipientId, sandboxId, userApp, deliveredEnv } =
      await createMultiHumanConversation('msg-recipient-hidden');

    const res = await userApp.request(
      '/v1/messages',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ conversationId, content: sampleContent }),
      },
      deliveredEnv
    );
    expect(res.status).toBe(201);

    const recipientMemberStub = env.MEMBERSHIP_DO.get(env.MEMBERSHIP_DO.idFromName(recipientId));
    const after = await recipientMemberStub.listConversations({ sandboxId });
    const conversation = after.conversations.find(c => c.conversationId === conversationId);
    if (!conversation) {
      throw new Error('Expected recipient membership conversation');
    }
    expect(conversation.lastActivityAt).not.toBeNull();
    expect(conversation.lastReadAt).toBeNull();
  });

  it('marks recipients read when the visible client explicitly marks the conversation read', async () => {
    const { conversationId, recipientId, sandboxId, userApp, recipientApp, deliveredEnv } =
      await createMultiHumanConversation('msg-recipient-visible');

    const createRes = await userApp.request(
      '/v1/messages',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ conversationId, content: sampleContent }),
      },
      deliveredEnv
    );
    expect(createRes.status).toBe(201);
    const { messageId } = await createRes.json<{ messageId: string }>();

    const markReadRes = await recipientApp.request(
      `/v1/conversations/${conversationId}/mark-read`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ lastSeenMessageId: messageId }),
      },
      deliveredEnv
    );
    expect(markReadRes.status).toBe(200);
    await expect(markReadRes.json()).resolves.toEqual({
      ok: true,
      applied: true,
      lastReadAt: ulidToTimestamp(messageId),
      badgeClear: {
        badgeBucket: badgeBucketForConversation(sandboxId, conversationId),
        badgeCount: 0,
      },
    });

    const recipientMemberStub = env.MEMBERSHIP_DO.get(env.MEMBERSHIP_DO.idFromName(recipientId));
    const after = await recipientMemberStub.listConversations({ sandboxId });
    const conversation = after.conversations.find(c => c.conversationId === conversationId);
    if (!conversation) {
      throw new Error('Expected recipient membership conversation');
    }
    const lastActivityAt = conversation.lastActivityAt;
    const lastReadAt = conversation.lastReadAt;
    if (lastActivityAt === null || lastReadAt === null) {
      throw new Error('Expected recipient conversation activity and read state');
    }
    expect(lastActivityAt).toBe(ulidToTimestamp(messageId));
    expect(lastReadAt).toBe(ulidToTimestamp(messageId));
    expect(lastReadAt).toBeGreaterThanOrEqual(lastActivityAt);
  });

  it('marks recipients read only through the latest message the client observed', async () => {
    const { conversationId, recipientId, sandboxId, userApp, recipientApp, deliveredEnv } =
      await createMultiHumanConversation('msg-recipient-stale-read');

    const firstMessageRes = await userApp.request(
      '/v1/messages',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          conversationId,
          content: [{ type: 'text', text: 'Message A' }],
        }),
      },
      deliveredEnv
    );
    expect(firstMessageRes.status).toBe(201);
    const { messageId: firstMessageId } = await firstMessageRes.json<{ messageId: string }>();

    await new Promise(resolve => setTimeout(resolve, 2));

    const secondMessageRes = await userApp.request(
      '/v1/messages',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          conversationId,
          content: [{ type: 'text', text: 'Message B' }],
        }),
      },
      deliveredEnv
    );
    expect(secondMessageRes.status).toBe(201);

    const markReadRes = await recipientApp.request(
      `/v1/conversations/${conversationId}/mark-read`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ lastSeenMessageId: firstMessageId }),
      },
      deliveredEnv
    );
    expect(markReadRes.status).toBe(200);
    await expect(markReadRes.json()).resolves.toEqual({
      ok: true,
      applied: true,
      lastReadAt: ulidToTimestamp(firstMessageId),
      badgeClear: null,
    });

    const recipientMemberStub = env.MEMBERSHIP_DO.get(env.MEMBERSHIP_DO.idFromName(recipientId));
    const after = await recipientMemberStub.listConversations({ sandboxId });
    const conversation = after.conversations.find(c => c.conversationId === conversationId);
    if (!conversation) {
      throw new Error('Expected recipient membership conversation');
    }
    const lastActivityAt = conversation.lastActivityAt;
    if (lastActivityAt === null) {
      throw new Error('Expected recipient conversation activity');
    }
    expect(conversation.lastReadAt).toBe(ulidToTimestamp(firstMessageId));
    expect(conversation.lastReadAt).toBeLessThan(lastActivityAt);
  });

  it('does not clear notification buckets when marking read through a stale message', async () => {
    const { conversationId, recipientId, sandboxId, userApp, recipientApp, deliveredEnv } =
      await createMultiHumanConversation('msg-recipient-stale-badge');

    const firstMessageRes = await userApp.request(
      '/v1/messages',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          conversationId,
          content: [{ type: 'text', text: 'Message A' }],
        }),
      },
      deliveredEnv
    );
    expect(firstMessageRes.status).toBe(201);
    const { messageId: firstMessageId } = await firstMessageRes.json<{ messageId: string }>();

    await new Promise(resolve => setTimeout(resolve, 2));

    const secondMessageRes = await userApp.request(
      '/v1/messages',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          conversationId,
          content: [{ type: 'text', text: 'Message B' }],
        }),
      },
      deliveredEnv
    );
    expect(secondMessageRes.status).toBe(201);

    const badgeBucket = badgeBucketForConversation(sandboxId, conversationId);
    await recordingNotifications.__incrementBadgeBucket({
      userId: recipientId,
      badgeBucket,
      delta: 1,
    });

    const markReadRes = await recipientApp.request(
      `/v1/conversations/${conversationId}/mark-read`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ lastSeenMessageId: firstMessageId }),
      },
      deliveredEnv
    );
    expect(markReadRes.status).toBe(200);
    await expect(markReadRes.json()).resolves.toEqual({
      ok: true,
      applied: true,
      lastReadAt: ulidToTimestamp(firstMessageId),
      badgeClear: null,
    });

    const recipientMemberStub = env.MEMBERSHIP_DO.get(env.MEMBERSHIP_DO.idFromName(recipientId));
    const after = await recipientMemberStub.listConversations({ sandboxId });
    const conversation = after.conversations.find(c => c.conversationId === conversationId);
    if (!conversation) {
      throw new Error('Expected recipient membership conversation');
    }
    const lastActivityAt = conversation.lastActivityAt;
    if (lastActivityAt === null) {
      throw new Error('Expected recipient conversation activity');
    }
    expect(conversation.lastReadAt).toBe(ulidToTimestamp(firstMessageId));
    expect(conversation.lastReadAt).toBeLessThan(lastActivityAt);
    await expect(recordingNotifications.__listNonZeroBuckets(recipientId)).resolves.toEqual([
      { badgeBucket, badgeCount: 1 },
    ]);
  });

  it('clears notification buckets when marking read through a deleted final message', async () => {
    const { conversationId, recipientId, sandboxId, userId, userApp, recipientApp, deliveredEnv } =
      await createMultiHumanConversation('msg-recipient-deleted-badge-clear');

    const createRes = await userApp.request(
      '/v1/messages',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ conversationId, content: sampleContent }),
      },
      deliveredEnv
    );
    expect(createRes.status).toBe(201);
    const { messageId } = await createRes.json<{ messageId: string }>();

    const badgeBucket = badgeBucketForConversation(sandboxId, conversationId);
    await recordingNotifications.__incrementBadgeBucket({
      userId: recipientId,
      badgeBucket,
      delta: 1,
    });

    const deleteQs = new URLSearchParams({ conversationId });
    const deleteRes = await userApp.request(
      `/v1/messages/${messageId}?${deleteQs.toString()}`,
      {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
      },
      deliveredEnv
    );
    expect(deleteRes.status).toBe(200);
    await expect(deleteRes.json()).resolves.toEqual({ ok: true });

    const markReadRes = await recipientApp.request(
      `/v1/conversations/${conversationId}/mark-read`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ lastSeenMessageId: messageId }),
      },
      deliveredEnv
    );
    expect(markReadRes.status).toBe(200);
    await expect(markReadRes.json()).resolves.toEqual({
      ok: true,
      applied: true,
      lastReadAt: ulidToTimestamp(messageId),
      badgeClear: { badgeBucket, badgeCount: 0 },
    });

    await expect(recordingNotifications.__listNonZeroBuckets(recipientId)).resolves.toEqual([]);
    await expect(recordingNotifications.__listNonZeroBuckets(userId)).resolves.toEqual([]);
  });

  it('clears stale notification buckets when recipients mark a conversation read', async () => {
    const { conversationId, recipientId, sandboxId, userApp, recipientApp, deliveredEnv } =
      await createMultiHumanConversation('msg-recipient-badge-clear');

    const createRes = await userApp.request(
      '/v1/messages',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ conversationId, content: sampleContent }),
      },
      deliveredEnv
    );
    expect(createRes.status).toBe(201);
    const { messageId } = await createRes.json<{ messageId: string }>();

    const firstMarkReadRes = await recipientApp.request(
      `/v1/conversations/${conversationId}/mark-read`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ lastSeenMessageId: messageId }),
      },
      deliveredEnv
    );
    expect(firstMarkReadRes.status).toBe(200);
    const badgeBucket = badgeBucketForConversation(sandboxId, conversationId);
    await expect(firstMarkReadRes.json()).resolves.toEqual({
      ok: true,
      applied: true,
      lastReadAt: ulidToTimestamp(messageId),
      badgeClear: { badgeBucket, badgeCount: 0 },
    });

    await recordingNotifications.__incrementBadgeBucket({
      userId: recipientId,
      badgeBucket,
      delta: 1,
    });
    await expect(recordingNotifications.__listNonZeroBuckets(recipientId)).resolves.toEqual([
      { badgeBucket, badgeCount: 1 },
    ]);

    const secondMarkReadRes = await recipientApp.request(
      `/v1/conversations/${conversationId}/mark-read`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ lastSeenMessageId: messageId }),
      },
      deliveredEnv
    );
    expect(secondMarkReadRes.status).toBe(200);
    await expect(secondMarkReadRes.json()).resolves.toEqual({
      ok: true,
      applied: false,
      lastReadAt: ulidToTimestamp(messageId),
      badgeClear: { badgeBucket, badgeCount: 0 },
    });

    await expect(recordingNotifications.__listNonZeroBuckets(recipientId)).resolves.toEqual([]);
  });

  it('returns retryable failure when required badge clearing fails', async () => {
    const { conversationId, recipientId, userApp, recipientApp, deliveredEnv } =
      await createMultiHumanConversation('msg-recipient-badge-clear-fails');

    const createRes = await userApp.request(
      '/v1/messages',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ conversationId, content: sampleContent }),
      },
      deliveredEnv
    );
    expect(createRes.status).toBe(201);
    const { messageId } = await createRes.json<{ messageId: string }>();

    const failingNotifications = {
      ...deliveredEnv.NOTIFICATIONS,
      clearBadgeBucketForUser: async () => {
        throw new Error('notifications unavailable');
      },
    } as Env['NOTIFICATIONS'];
    const failingEnv = { ...deliveredEnv, NOTIFICATIONS: failingNotifications } satisfies Env;

    const markReadRes = await recipientApp.request(
      `/v1/conversations/${conversationId}/mark-read`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ lastSeenMessageId: messageId }),
      },
      failingEnv
    );

    expect(markReadRes.status).toBe(503);
    await expect(markReadRes.json()).resolves.toEqual({
      error: 'Failed to clear notification badge',
    });

    const recipientMemberStub = env.MEMBERSHIP_DO.get(env.MEMBERSHIP_DO.idFromName(recipientId));
    const after = await recipientMemberStub.listConversations({});
    const conversation = after.conversations.find(c => c.conversationId === conversationId);
    expect(conversation?.lastReadAt).toBe(ulidToTimestamp(messageId));
  });
});

describe('POST /v1/conversations/:conversationId/messages/:messageId/execute-action', () => {
  it('returns the canonical resolved action content', async () => {
    const { conversationId, userApp, botId } = await createConversation('execute-action-result');
    const convStub = getConvStub(conversationId);
    const create = await convStub.createMessage({
      senderId: botId,
      content: [
        {
          type: 'actions',
          groupId: 'approval',
          actions: [
            { value: 'allow-once', label: 'Allow', style: 'primary' },
            { value: 'deny', label: 'Deny', style: 'danger' },
          ],
        },
      ],
    });
    expect(create.ok).toBe(true);
    if (!create.ok) return;

    const beforeExecute = Date.now();
    const res = await userApp.request(
      `/v1/conversations/${conversationId}/messages/${create.messageId}/execute-action`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ groupId: 'approval', value: 'deny' }),
      },
      env
    );

    expect(res.status).toBe(200);
    const body = await res.json<{
      ok: true;
      messageId: string;
      content: Array<{
        type: string;
        groupId?: string;
        resolved?: { value: string; resolvedBy: string; resolvedAt: number };
      }>;
      resolved: { groupId: string; value: string; resolvedBy: string; resolvedAt: number };
    }>();
    expect(body.messageId).toBe(create.messageId);
    expect(body.resolved.groupId).toBe('approval');
    expect(body.resolved.value).toBe('deny');
    expect(body.resolved.resolvedBy).toBe('user-execute-action-result');
    expect(body.resolved.resolvedAt).toBeGreaterThanOrEqual(beforeExecute);
    expect(body.content.find(block => block.type === 'actions')?.resolved).toEqual({
      value: 'deny',
      resolvedBy: 'user-execute-action-result',
      resolvedAt: body.resolved.resolvedAt,
    });
  });

  it('does not enqueue action.executed when the author bot has left', async () => {
    await recordingKiloclaw.__clearWebhookCalls();
    const conversationId = ulid();
    const userId = 'user-execute-left-author';
    const authorBotId = 'bot:kiloclaw:sandbox-execute-left-author';
    const activeBotId = 'bot:kiloclaw:sandbox-execute-still-active';
    const userApp = makeApp(userId, 'user');
    const convStub = getConvStub(conversationId);
    await convStub.initialize({
      id: conversationId,
      title: 'Action Chat',
      createdBy: userId,
      createdAt: Date.now(),
      members: [
        { id: userId, kind: 'user' },
        { id: authorBotId, kind: 'bot' },
        { id: activeBotId, kind: 'bot' },
      ],
    });
    const create = await convStub.createMessage({
      senderId: authorBotId,
      content: [
        {
          type: 'actions',
          groupId: 'approval',
          actions: [{ value: 'deny', label: 'Deny', style: 'danger' }],
        },
      ],
    });
    expect(create.ok).toBe(true);
    if (!create.ok) return;
    await convStub.leaveMember(authorBotId);

    const res = await userApp.request(
      `/v1/conversations/${conversationId}/messages/${create.messageId}/execute-action`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ groupId: 'approval', value: 'deny' }),
      },
      env
    );

    expect(res.status).toBe(200);
    await new Promise(resolve => setTimeout(resolve, 50));
    const calls = await recordingKiloclaw.__recordedWebhookCalls();
    expect(
      calls.some(call => call.conversationId === conversationId && call.type === 'action.executed')
    ).toBe(false);
  });
});

describe('auto-title on first message', () => {
  it('auto-titles an untitled conversation from first message text', async () => {
    const userId = 'user-autotitle';
    const sandboxId = 'sandbox-autotitle';
    const userApp = makeApp(userId, 'user');

    // Create conversation WITHOUT a title
    const convRes = await userApp.request(
      '/v1/conversations',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sandboxId }),
      },
      env
    );
    expect(convRes.status).toBe(201);
    const { conversationId } = await convRes.json<{ conversationId: string }>();

    const convStub = getConvStub(conversationId);
    expect((await convStub.getInfo())!.title).toBeNull();

    // Send a message — triggers auto-title
    const res = await userApp.request(
      '/v1/messages',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          conversationId,
          content: [{ type: 'text', text: 'Hello world' }],
        }),
      },
      env
    );
    expect(res.status).toBe(201);

    // Both the message and auto-title should succeed, and auto-title failure
    // is wrapped in try-catch so it cannot reject the send.
    const infoAfter = await convStub.getInfo();
    expect(infoAfter!.title).toBe('Hello world');

    const { messages } = await convStub.listMessages({ limit: 10 });
    expect(messages).toHaveLength(1);
  });

  it('keeps the first auto-title when a later fan-out also observed no title', async () => {
    const userId = 'user-autotitle-race';
    const sandboxId = 'sandbox-autotitle-race';
    const botId = `bot:kiloclaw:${sandboxId}`;
    const conversationId = ulid();
    const joinedAt = Date.now();
    const members: Array<{ id: string; kind: 'user' | 'bot' }> = [
      { id: userId, kind: 'user' },
      { id: botId, kind: 'bot' },
    ];

    const convStub = getConvStub(conversationId);
    const initResult = await convStub.initialize({
      id: conversationId,
      title: null,
      createdBy: userId,
      createdAt: joinedAt,
      members,
    });
    expect(initResult).toEqual({ ok: true });

    for (const member of members) {
      await env.MEMBERSHIP_DO.get(env.MEMBERSHIP_DO.idFromName(member.id)).addConversation({
        conversationId,
        title: null,
        sandboxId,
        joinedAt,
      });
    }

    const staleInfo = {
      id: conversationId,
      title: null,
      createdBy: userId,
      createdAt: joinedAt,
      members,
    };
    const pushedEvents: Array<{ event: string; payload: unknown }> = [];
    const pushEvent = vi.fn(
      async (_userId: string, _context: string, event: string, payload: unknown) => {
        pushedEvents.push({ event, payload });
        return true;
      }
    );
    const eventEnv = {
      ...env,
      EVENT_SERVICE: {
        fetch: env.EVENT_SERVICE.fetch.bind(env.EVENT_SERVICE),
        connect: env.EVENT_SERVICE.connect.bind(env.EVENT_SERVICE),
        pushEvent,
      },
    } satisfies Env;

    await postCommitFanOut(
      eventEnv,
      staleInfo,
      userId,
      conversationId,
      ulid(),
      [{ type: 'text', text: 'First title' }],
      undefined,
      undefined
    );
    await postCommitFanOut(
      eventEnv,
      staleInfo,
      userId,
      conversationId,
      ulid(),
      [{ type: 'text', text: 'Second title' }],
      undefined,
      undefined
    );

    const infoAfter = await convStub.getInfo();
    expect(infoAfter!.title).toBe('First title');

    const userMembership = await env.MEMBERSHIP_DO.get(
      env.MEMBERSHIP_DO.idFromName(userId)
    ).listConversations({ sandboxId });
    const botMembership = await env.MEMBERSHIP_DO.get(
      env.MEMBERSHIP_DO.idFromName(botId)
    ).listConversations({ sandboxId });
    expect(userMembership.conversations[0].title).toBe('First title');
    expect(botMembership.conversations[0].title).toBe('First title');

    const renamedPayloads = pushedEvents
      .filter(pushedEvent => pushedEvent.event === 'conversation.renamed')
      .map(pushedEvent => pushedEvent.payload);
    expect(renamedPayloads).toEqual([{ conversationId, title: 'First title' }]);
  });

  it('publishes reply snapshots on message.created events', async () => {
    const { conversationId, userId } = await createMultiHumanConversation('reply-event-snapshot');
    const convStub = getConvStub(conversationId);
    const info = await convStub.getInfo();
    expect(info).not.toBeNull();
    if (!info) return;

    const parent = await convStub.createMessage({
      senderId: 'recipient-reply-event-snapshot',
      content: [{ type: 'text', text: 'Parent context' }],
    });
    expect(parent.ok).toBe(true);
    if (!parent.ok) return;

    const replyMessageId = ulid();
    const pushedEvents: Array<{ event: string; payload: unknown }> = [];
    const pushEvent = vi.fn(
      async (_userId: string, _context: string, event: string, payload: unknown) => {
        pushedEvents.push({ event, payload });
        return true;
      }
    );
    const eventEnv = {
      ...env,
      EVENT_SERVICE: {
        fetch: env.EVENT_SERVICE.fetch.bind(env.EVENT_SERVICE),
        connect: env.EVENT_SERVICE.connect.bind(env.EVENT_SERVICE),
        pushEvent,
      },
    } satisfies Env;

    await postCommitFanOut(
      eventEnv,
      info,
      userId,
      conversationId,
      replyMessageId,
      [{ type: 'text', text: 'Reply body' }],
      parent.messageId,
      undefined
    );

    const createdPayloads = pushedEvents
      .filter(pushedEvent => pushedEvent.event === 'message.created')
      .map(pushedEvent => pushedEvent.payload);
    expect(createdPayloads).toEqual([
      {
        messageId: replyMessageId,
        senderId: userId,
        content: [{ type: 'text', text: 'Reply body' }],
        inReplyToMessageId: parent.messageId,
        replyTo: {
          messageId: parent.messageId,
          senderId: 'recipient-reply-event-snapshot',
          deleted: false,
          previewText: 'Parent context',
        },
        clientId: null,
      },
      {
        messageId: replyMessageId,
        senderId: userId,
        content: [{ type: 'text', text: 'Reply body' }],
        inReplyToMessageId: parent.messageId,
        replyTo: {
          messageId: parent.messageId,
          senderId: 'recipient-reply-event-snapshot',
          deleted: false,
          previewText: 'Parent context',
        },
        clientId: null,
      },
    ]);
  });

  it('shares the reply parent lookup across webhook and message events', async () => {
    const { conversationId, userId } = await createMultiHumanConversation('reply-shared-parent');
    const convStub = getConvStub(conversationId);
    const info = await convStub.getInfo();
    expect(info).not.toBeNull();
    if (!info) return;

    const parent = await convStub.createMessage({
      senderId: 'recipient-reply-shared-parent',
      content: [{ type: 'text', text: 'Parent context' }],
    });
    expect(parent.ok).toBe(true);
    if (!parent.ok) return;

    const getMessage = vi.fn((messageId: string) => convStub.getMessage(messageId));
    const countedConvStub = Object.assign(Object.create(convStub) as typeof convStub, {
      getMessage,
    });
    const countedConversationDo = Object.assign(
      Object.create(env.CONVERSATION_DO) as typeof env.CONVERSATION_DO,
      {
        get: () => countedConvStub,
        idFromName: (name: string) => env.CONVERSATION_DO.idFromName(name),
      }
    );
    const eventEnv = {
      ...env,
      CONVERSATION_DO: countedConversationDo,
      EVENT_SERVICE: {
        fetch: env.EVENT_SERVICE.fetch.bind(env.EVENT_SERVICE),
        connect: env.EVENT_SERVICE.connect.bind(env.EVENT_SERVICE),
        pushEvent: async () => true,
      },
    } satisfies Env;

    await postCommitFanOut(
      eventEnv,
      info,
      userId,
      conversationId,
      ulid(),
      [{ type: 'text', text: 'Reply body' }],
      parent.messageId,
      undefined
    );

    expect(getMessage).toHaveBeenCalledOnce();
  });

  it('does not publish automatic typing.stop events for human messages', async () => {
    const { conversationId, userId } = await createMultiHumanConversation('human-message-events');
    const convStub = getConvStub(conversationId);
    const info = await convStub.getInfo();
    expect(info).not.toBeNull();
    if (!info) return;

    const pushedEvents: Array<{ event: string; userId: string }> = [];
    const pushEvent = vi.fn(async (eventUserId: string, _context: string, event: string) => {
      pushedEvents.push({ event, userId: eventUserId });
      return true;
    });
    const eventEnv = {
      ...env,
      EVENT_SERVICE: {
        fetch: env.EVENT_SERVICE.fetch.bind(env.EVENT_SERVICE),
        connect: env.EVENT_SERVICE.connect.bind(env.EVENT_SERVICE),
        pushEvent,
      },
    } satisfies Env;

    await postCommitFanOut(
      eventEnv,
      info,
      userId,
      conversationId,
      ulid(),
      [{ type: 'text', text: 'Hello humans' }],
      undefined,
      undefined
    );

    expect(pushedEvents.filter(pushedEvent => pushedEvent.event === 'message.created')).toEqual([
      { event: 'message.created', userId },
      { event: 'message.created', userId: 'recipient-human-message-events' },
    ]);
    expect(pushedEvents.some(pushedEvent => pushedEvent.event === 'typing.stop')).toBe(false);
  });
});
