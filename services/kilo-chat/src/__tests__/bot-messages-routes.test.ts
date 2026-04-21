import { env } from 'cloudflare:test';
import { describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';
import type { AuthContext } from '../auth';
import { botAuthMiddleware } from '../auth-bot';
import { registerBotRoutes } from '../routes/bot-messages';
import { registerConversationRoutes } from '../routes/conversations';
import { registerMessageRoutes } from '../routes/messages';
import { deriveGatewayToken } from '../lib/gateway-token';

const ownershipMap = new Map<string, Set<string>>();

vi.mock('../services/sandbox-ownership', () => ({
  userOwnsSandbox: async (_conn: string, userId: string, sandboxId: string) =>
    ownershipMap.get(userId)?.has(sandboxId) ?? false,
}));

function grantSandbox(userId: string, sandboxId: string) {
  if (!ownershipMap.has(userId)) ownershipMap.set(userId, new Set());
  ownershipMap.get(userId)!.add(sandboxId);
}

const SECRET = 'test-gateway-secret';

/** Build an env that has all DO bindings from the test harness plus the secret. */
function makeEnv(): Env {
  return { ...env, GATEWAY_TOKEN_SECRET: { get: () => Promise.resolve(SECRET) } } as unknown as Env;
}

/** App with bot auth middleware + bot routes. Also registers conversation + message
 *  routes so we can set up test data (create conversations, messages) using user
 *  identity via a simple mock auth shortcut. */
function makeBotApp() {
  const app = new Hono<{ Bindings: Env; Variables: AuthContext }>();
  app.use('/bot/v1/sandboxes/:sandboxId/*', botAuthMiddleware);
  registerBotRoutes(app);
  return app;
}

/** Auth token for a given sandboxId. */
async function tokenFor(sandboxId: string): Promise<string> {
  return deriveGatewayToken(sandboxId, SECRET);
}

/** Helper to create a conversation + optionally a message as a user.
 *  Uses registerConversationRoutes and registerMessageRoutes directly with a
 *  mock-auth app so we don't need a real JWT. */
async function setupData(suffix: string) {
  const userId = `user-${suffix}`;
  const sandboxId = `sandbox-${suffix}`;

  grantSandbox(userId, sandboxId);

  // Minimal app with mock auth for setup
  const setupApp = new Hono<{ Bindings: Env; Variables: AuthContext }>();
  setupApp.use('*', async (c, next) => {
    c.set('callerId', userId);
    c.set('callerKind', 'user');
    await next();
  });
  registerConversationRoutes(setupApp);
  registerMessageRoutes(setupApp);

  const testEnv = makeEnv();

  const convRes = await setupApp.request(
    '/v1/conversations',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sandboxId, title: `Chat ${suffix}` }),
    },
    testEnv
  );
  expect(convRes.status).toBe(201);
  const { conversationId } = await convRes.json<{ conversationId: string }>();

  const msgRes = await setupApp.request(
    '/v1/messages',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        conversationId,
        content: [{ type: 'text', text: 'hello' }],
      }),
    },
    testEnv
  );
  expect(msgRes.status).toBe(201);
  const { messageId } = await msgRes.json<{ messageId: string }>();

  return { sandboxId, conversationId, messageId, testEnv };
}

const sampleContent = [{ type: 'text', text: 'Hello from bot' }];

// ─── POST /bot/v1/sandboxes/:sandboxId/messages ───────────────────────────────

describe('POST /bot/v1/sandboxes/:sandboxId/messages', () => {
  it('creates a message and returns 201 with { messageId }', async () => {
    const { sandboxId, conversationId, testEnv } = await setupData('bot-create-1');
    const app = makeBotApp();
    const token = await tokenFor(sandboxId);

    const res = await app.request(
      `/bot/v1/sandboxes/${sandboxId}/messages`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ conversationId, content: sampleContent }),
      },
      testEnv
    );

    expect(res.status).toBe(201);
    const body = await res.json<{ messageId: string }>();
    expect(body.messageId).toMatch(/^[0-9A-Z]{26}$/);
  });

  it('returns 400 for invalid JSON', async () => {
    const { sandboxId, testEnv } = await setupData('bot-create-badjson');
    const app = makeBotApp();
    const token = await tokenFor(sandboxId);

    const res = await app.request(
      `/bot/v1/sandboxes/${sandboxId}/messages`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: 'not-json',
      },
      testEnv
    );

    expect(res.status).toBe(400);
  });

  it('returns 400 when content is missing', async () => {
    const { sandboxId, conversationId, testEnv } = await setupData('bot-create-nocontent');
    const app = makeBotApp();
    const token = await tokenFor(sandboxId);

    const res = await app.request(
      `/bot/v1/sandboxes/${sandboxId}/messages`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ conversationId }), // missing content
      },
      testEnv
    );

    expect(res.status).toBe(400);
  });

  it('returns 401 without auth token', async () => {
    const { sandboxId, conversationId, testEnv } = await setupData('bot-create-noauth');
    const app = makeBotApp();

    const res = await app.request(
      `/bot/v1/sandboxes/${sandboxId}/messages`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ conversationId, content: sampleContent }),
      },
      testEnv
    );

    expect(res.status).toBe(401);
  });

  it('returns 403 when bot is not a member of the conversation', async () => {
    const { conversationId, testEnv } = await setupData('bot-create-notmember');
    // Use a DIFFERENT sandboxId than the one that created the conversation
    const otherSandboxId = 'other-sandbox-123';
    const app = makeBotApp();
    const token = await tokenFor(otherSandboxId);

    const res = await app.request(
      `/bot/v1/sandboxes/${otherSandboxId}/messages`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ conversationId, content: sampleContent }),
      },
      testEnv
    );

    expect(res.status).toBe(403);
  });
});

// ─── PATCH /bot/v1/sandboxes/:sandboxId/messages/:messageId ──────────────────

describe('PATCH /bot/v1/sandboxes/:sandboxId/messages/:messageId', () => {
  it('edits a bot-owned message and returns 200 with { messageId }', async () => {
    const { sandboxId, conversationId, testEnv } = await setupData('bot-edit-1');
    const app = makeBotApp();
    const token = await tokenFor(sandboxId);

    const createRes = await app.request(
      `/bot/v1/sandboxes/${sandboxId}/messages`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ conversationId, content: sampleContent }),
      },
      testEnv
    );
    expect(createRes.status).toBe(201);
    const { messageId } = await createRes.json<{ messageId: string }>();

    const editRes = await app.request(
      `/bot/v1/sandboxes/${sandboxId}/messages/${messageId}`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({
          conversationId,
          content: [{ type: 'text', text: 'Edited by bot' }],
          timestamp: Date.now(),
        }),
      },
      testEnv
    );

    expect(editRes.status).toBe(200);
    const body = await editRes.json<{ messageId: string }>();
    expect(body.messageId).toBe(messageId);
  });

  it('discards stale edit (older timestamp)', async () => {
    const { sandboxId, conversationId, testEnv } = await setupData('bot-edit-stale');
    const app = makeBotApp();
    const token = await tokenFor(sandboxId);

    const createRes = await app.request(
      `/bot/v1/sandboxes/${sandboxId}/messages`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ conversationId, content: sampleContent }),
      },
      testEnv
    );
    const { messageId } = await createRes.json<{ messageId: string }>();

    // First edit with timestamp 1000
    await app.request(
      `/bot/v1/sandboxes/${sandboxId}/messages/${messageId}`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({
          conversationId,
          content: [{ type: 'text', text: 'Edit 1' }],
          timestamp: 1000,
        }),
      },
      testEnv
    );

    // Second edit with older timestamp
    const editRes = await app.request(
      `/bot/v1/sandboxes/${sandboxId}/messages/${messageId}`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({
          conversationId,
          content: [{ type: 'text', text: 'Stale edit' }],
          timestamp: 500,
        }),
      },
      testEnv
    );

    expect(editRes.status).toBe(409);
  });

  it('returns 400 for invalid messageId', async () => {
    const { sandboxId, conversationId, testEnv } = await setupData('bot-edit-badid');
    const app = makeBotApp();
    const token = await tokenFor(sandboxId);

    const res = await app.request(
      `/bot/v1/sandboxes/${sandboxId}/messages/not-a-ulid`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({
          conversationId,
          content: sampleContent,
          timestamp: Date.now(),
        }),
      },
      testEnv
    );

    expect(res.status).toBe(400);
  });

  it('returns 400 for missing required fields', async () => {
    const { sandboxId, conversationId, testEnv } = await setupData('bot-edit-missing');
    const app = makeBotApp();
    const token = await tokenFor(sandboxId);

    const res = await app.request(
      `/bot/v1/sandboxes/${sandboxId}/messages/01ARZ3NDEKTSV4RRFFQ69G5FAV`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ conversationId }), // missing content and timestamp
      },
      testEnv
    );

    expect(res.status).toBe(400);
  });

  it("returns 403 when editing another bot's message", async () => {
    const { sandboxId, conversationId, messageId, testEnv } = await setupData('bot-edit-forbidden');
    // messageId was created by the user in setupData; the bot is a member but didn't author it
    const app = makeBotApp();
    const token = await tokenFor(sandboxId);

    const editRes = await app.request(
      `/bot/v1/sandboxes/${sandboxId}/messages/${messageId}`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({
          conversationId,
          content: [{ type: 'text', text: 'Bot editing user msg' }],
          timestamp: Date.now(),
        }),
      },
      testEnv
    );

    expect(editRes.status).toBe(403);
  });
});

// ─── DELETE /bot/v1/sandboxes/:sandboxId/messages/:messageId ─────────────────

describe('DELETE /bot/v1/sandboxes/:sandboxId/messages/:messageId', () => {
  it('soft-deletes a bot-owned message and returns 204', async () => {
    const { sandboxId, conversationId, testEnv } = await setupData('bot-del-1');
    const app = makeBotApp();
    const token = await tokenFor(sandboxId);

    const createRes = await app.request(
      `/bot/v1/sandboxes/${sandboxId}/messages`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ conversationId, content: sampleContent }),
      },
      testEnv
    );
    const { messageId } = await createRes.json<{ messageId: string }>();

    const delRes = await app.request(
      `/bot/v1/sandboxes/${sandboxId}/messages/${messageId}`,
      {
        method: 'DELETE',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ conversationId }),
      },
      testEnv
    );

    expect(delRes.status).toBe(204);
  });

  it('returns 404 for non-existent message', async () => {
    const { sandboxId, conversationId, testEnv } = await setupData('bot-del-notfound');
    const app = makeBotApp();
    const token = await tokenFor(sandboxId);

    const res = await app.request(
      `/bot/v1/sandboxes/${sandboxId}/messages/01ARZ3NDEKTSV4RRFFQ69G5FAV`,
      {
        method: 'DELETE',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ conversationId }),
      },
      testEnv
    );

    expect(res.status).toBe(404);
  });

  it("returns 403 when deleting another user's message", async () => {
    const { sandboxId, conversationId, messageId, testEnv } = await setupData('bot-del-forbidden');
    const app = makeBotApp();
    const token = await tokenFor(sandboxId);

    const delRes = await app.request(
      `/bot/v1/sandboxes/${sandboxId}/messages/${messageId}`,
      {
        method: 'DELETE',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ conversationId }),
      },
      testEnv
    );

    expect(delRes.status).toBe(403);
  });

  it('returns 400 for invalid messageId', async () => {
    const { sandboxId, conversationId, testEnv } = await setupData('bot-del-badid');
    const app = makeBotApp();
    const token = await tokenFor(sandboxId);

    const res = await app.request(
      `/bot/v1/sandboxes/${sandboxId}/messages/bad-id`,
      {
        method: 'DELETE',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ conversationId }),
      },
      testEnv
    );

    expect(res.status).toBe(400);
  });

  it('returns 400 when body is missing conversationId', async () => {
    const { sandboxId, testEnv } = await setupData('bot-del-nobody');
    const app = makeBotApp();
    const token = await tokenFor(sandboxId);

    const res = await app.request(
      `/bot/v1/sandboxes/${sandboxId}/messages/01ARZ3NDEKTSV4RRFFQ69G5FAV`,
      {
        method: 'DELETE',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({}),
      },
      testEnv
    );

    expect(res.status).toBe(400);
  });
});

// ─── POST /bot/v1/sandboxes/:sandboxId/conversations/:conversationId/typing ───

describe('POST /bot/v1/sandboxes/:sandboxId/conversations/:conversationId/typing', () => {
  it('returns 204 for a member bot', async () => {
    const { sandboxId, conversationId, testEnv } = await setupData('bot-typing-ok');
    const app = makeBotApp();
    const token = await tokenFor(sandboxId);

    const res = await app.request(
      `/bot/v1/sandboxes/${sandboxId}/conversations/${conversationId}/typing`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
      },
      testEnv
    );

    expect(res.status).toBe(204);
  });

  it('returns 403 for non-member bot', async () => {
    const { conversationId, testEnv } = await setupData('bot-typing-forbidden');
    const otherSandboxId = 'other-sandbox-typing';
    const app = makeBotApp();
    const token = await tokenFor(otherSandboxId);

    const res = await app.request(
      `/bot/v1/sandboxes/${otherSandboxId}/conversations/${conversationId}/typing`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
      },
      testEnv
    );

    expect(res.status).toBe(403);
  });

  it('returns 401 without auth', async () => {
    const { sandboxId, conversationId, testEnv } = await setupData('bot-typing-noauth');
    const app = makeBotApp();

    const res = await app.request(
      `/bot/v1/sandboxes/${sandboxId}/conversations/${conversationId}/typing`,
      { method: 'POST' },
      testEnv
    );

    expect(res.status).toBe(401);
  });

  it('returns 400 when conversationId path param is not a valid ULID', async () => {
    const { sandboxId, testEnv } = await setupData('bot-typing-bad-convid');
    const app = makeBotApp();
    const token = await tokenFor(sandboxId);

    const res = await app.request(
      `/bot/v1/sandboxes/${sandboxId}/conversations/not-a-ulid/typing`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
      },
      testEnv
    );

    expect(res.status).toBe(400);
  });
});

// ─── POST /bot/v1/sandboxes/:sandboxId/messages/:messageId/reactions ─────────

describe('POST /bot/v1/sandboxes/:sandboxId/messages/:messageId/reactions', () => {
  it('returns 201 on first add, returns { id }', async () => {
    const { sandboxId, conversationId, messageId, testEnv } = await setupData('bot-rx-add-1');
    const app = makeBotApp();
    const token = await tokenFor(sandboxId);

    const res = await app.request(
      `/bot/v1/sandboxes/${sandboxId}/messages/${messageId}/reactions`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ conversationId, emoji: '👍' }),
      },
      testEnv
    );

    expect(res.status).toBe(201);
    const body = await res.json<{ id: string }>();
    expect(body.id).toMatch(/^[0-9A-Z]{26}$/);
  });

  it('returns 200 on duplicate add (idempotent)', async () => {
    const { sandboxId, conversationId, messageId, testEnv } = await setupData('bot-rx-add-dup');
    const app = makeBotApp();
    const token = await tokenFor(sandboxId);

    const post = () =>
      app.request(
        `/bot/v1/sandboxes/${sandboxId}/messages/${messageId}/reactions`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
          body: JSON.stringify({ conversationId, emoji: '👍' }),
        },
        testEnv
      );

    const first = await post();
    const firstBody = await first.json<{ id: string }>();
    const second = await post();
    expect(second.status).toBe(200);
    const secondBody = await second.json<{ id: string }>();
    expect(secondBody.id).toBe(firstBody.id);
  });

  it('returns 400 for invalid messageId', async () => {
    const { sandboxId, conversationId, testEnv } = await setupData('bot-rx-add-badid');
    const app = makeBotApp();
    const token = await tokenFor(sandboxId);

    const res = await app.request(
      `/bot/v1/sandboxes/${sandboxId}/messages/not-a-ulid/reactions`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ conversationId, emoji: '👍' }),
      },
      testEnv
    );

    expect(res.status).toBe(400);
  });

  it('returns 400 for empty emoji', async () => {
    const { sandboxId, conversationId, messageId, testEnv } = await setupData('bot-rx-empty-emoji');
    const app = makeBotApp();
    const token = await tokenFor(sandboxId);

    const res = await app.request(
      `/bot/v1/sandboxes/${sandboxId}/messages/${messageId}/reactions`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ conversationId, emoji: '' }),
      },
      testEnv
    );

    expect(res.status).toBe(400);
  });

  it('returns 403 for non-member bot', async () => {
    const { conversationId, messageId, testEnv } = await setupData('bot-rx-add-forbidden');
    const otherSandboxId = 'other-sandbox-rx';
    const app = makeBotApp();
    const token = await tokenFor(otherSandboxId);

    const res = await app.request(
      `/bot/v1/sandboxes/${otherSandboxId}/messages/${messageId}/reactions`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ conversationId, emoji: '👍' }),
      },
      testEnv
    );

    expect(res.status).toBe(403);
  });
});

// ─── GET /bot/v1/sandboxes/:sandboxId/conversations/:conversationId/messages ──

describe('GET /bot/v1/sandboxes/:sandboxId/conversations/:conversationId/messages', () => {
  it('returns messages for a valid bot member', async () => {
    const { sandboxId, conversationId, messageId, testEnv } = await setupData('bot-list-1');
    const app = makeBotApp();
    const token = await tokenFor(sandboxId);

    const res = await app.request(
      `/bot/v1/sandboxes/${sandboxId}/conversations/${conversationId}/messages`,
      {
        method: 'GET',
        headers: { authorization: `Bearer ${token}` },
      },
      testEnv
    );

    expect(res.status).toBe(200);
    const body = await res.json<{ messages: { id: string }[] }>();
    expect(Array.isArray(body.messages)).toBe(true);
    expect(body.messages.some(m => m.id === messageId)).toBe(true);
  });

  it('returns 403 for a non-member bot', async () => {
    const { conversationId, testEnv } = await setupData('bot-list-forbidden');
    const otherSandboxId = 'other-sandbox-list';
    const app = makeBotApp();
    const token = await tokenFor(otherSandboxId);

    const res = await app.request(
      `/bot/v1/sandboxes/${otherSandboxId}/conversations/${conversationId}/messages`,
      {
        method: 'GET',
        headers: { authorization: `Bearer ${token}` },
      },
      testEnv
    );

    expect(res.status).toBe(403);
  });
});

// ─── GET /bot/v1/sandboxes/:sandboxId/conversations/:conversationId/members ───

describe('GET /bot/v1/sandboxes/:sandboxId/conversations/:conversationId/members', () => {
  it('returns members for a valid bot member (200)', async () => {
    const { sandboxId, conversationId, testEnv } = await setupData('bot-members-1');
    const app = makeBotApp();
    const token = await tokenFor(sandboxId);

    const res = await app.request(
      `/bot/v1/sandboxes/${sandboxId}/conversations/${conversationId}/members`,
      {
        method: 'GET',
        headers: { authorization: `Bearer ${token}` },
      },
      testEnv
    );

    expect(res.status).toBe(200);
    const body = await res.json<{ members: { id: string; kind: string }[] }>();
    expect(Array.isArray(body.members)).toBe(true);
    // Should contain the user (created the conversation) and the bot (sandboxId)
    const ids = body.members.map(m => m.id);
    expect(ids).toContain(`user-bot-members-1`);
    expect(ids).toContain(`bot:kiloclaw:${sandboxId}`);
  });

  it('returns 403 for a non-member bot', async () => {
    const { conversationId, testEnv } = await setupData('bot-members-forbidden');
    const otherSandboxId = 'other-sandbox-members';
    const app = makeBotApp();
    const token = await tokenFor(otherSandboxId);

    const res = await app.request(
      `/bot/v1/sandboxes/${otherSandboxId}/conversations/${conversationId}/members`,
      {
        method: 'GET',
        headers: { authorization: `Bearer ${token}` },
      },
      testEnv
    );

    expect(res.status).toBe(403);
  });
});

// ─── DELETE /bot/v1/sandboxes/:sandboxId/messages/:messageId/reactions ────────

describe('DELETE /bot/v1/sandboxes/:sandboxId/messages/:messageId/reactions', () => {
  it('returns 204 after removing a reaction', async () => {
    const { sandboxId, conversationId, messageId, testEnv } = await setupData('bot-rx-del-1');
    const app = makeBotApp();
    const token = await tokenFor(sandboxId);

    // Add first
    await app.request(
      `/bot/v1/sandboxes/${sandboxId}/messages/${messageId}/reactions`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ conversationId, emoji: '👍' }),
      },
      testEnv
    );

    const res = await app.request(
      `/bot/v1/sandboxes/${sandboxId}/messages/${messageId}/reactions`,
      {
        method: 'DELETE',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ conversationId, emoji: '👍' }),
      },
      testEnv
    );

    expect(res.status).toBe(204);
  });

  it('returns 204 even when reaction never existed (idempotent)', async () => {
    const { sandboxId, conversationId, messageId, testEnv } = await setupData('bot-rx-del-idem');
    const app = makeBotApp();
    const token = await tokenFor(sandboxId);

    const res = await app.request(
      `/bot/v1/sandboxes/${sandboxId}/messages/${messageId}/reactions`,
      {
        method: 'DELETE',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ conversationId, emoji: '❤️' }),
      },
      testEnv
    );

    expect(res.status).toBe(204);
  });

  it('returns 403 for non-member bot', async () => {
    const { conversationId, messageId, testEnv } = await setupData('bot-rx-del-forbidden');
    const otherSandboxId = 'other-sandbox-rx-del';
    const app = makeBotApp();
    const token = await tokenFor(otherSandboxId);

    const res = await app.request(
      `/bot/v1/sandboxes/${otherSandboxId}/messages/${messageId}/reactions`,
      {
        method: 'DELETE',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ conversationId, emoji: '👍' }),
      },
      testEnv
    );

    expect(res.status).toBe(403);
  });

  it('returns 400 for missing emoji field', async () => {
    const { sandboxId, conversationId, messageId, testEnv } = await setupData('bot-rx-del-bad');
    const app = makeBotApp();
    const token = await tokenFor(sandboxId);

    const res = await app.request(
      `/bot/v1/sandboxes/${sandboxId}/messages/${messageId}/reactions`,
      {
        method: 'DELETE',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ conversationId }), // missing emoji
      },
      testEnv
    );

    expect(res.status).toBe(400);
  });
});
