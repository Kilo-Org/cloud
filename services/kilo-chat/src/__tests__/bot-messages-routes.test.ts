import { env } from 'cloudflare:test';
import { describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';
import type { AuthContext } from '../auth';
import { botAuthMiddleware } from '../auth-bot';
import { registerBotRoutes } from '../routes/bot-messages';
import { registerConversationRoutes } from '../routes/conversations';
import { handleCreateMessage, handleExecuteAction } from '../routes/handler';
import { deriveGatewayToken } from '../lib/gateway-token';
import { withTestExecutionCtx } from './helpers';

const ownershipMap = new Map<string, Set<string>>();
const sandboxOwnerMap = new Map<string, string>();

vi.mock('../services/sandbox-ownership', () => ({
  userOwnsSandbox: async (_env: Env, userId: string, sandboxId: string) =>
    ownershipMap.get(userId)?.has(sandboxId) ?? false,
  lookupSandboxOwnerUserId: async (_env: Env, sandboxId: string) =>
    sandboxOwnerMap.get(sandboxId) ?? null,
}));

vi.mock('../services/user-lookup', () => ({
  resolveUserDisplayInfo: async () => new Map(),
  validateUserIds: async (_conn: string, userIds: string[]) => ({
    valid: userIds,
    invalid: [],
  }),
}));

function grantSandbox(userId: string, sandboxId: string) {
  if (!ownershipMap.has(userId)) ownershipMap.set(userId, new Set());
  ownershipMap.get(userId)!.add(sandboxId);
  sandboxOwnerMap.set(sandboxId, userId);
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
  return withTestExecutionCtx(app);
}

/** Auth token for a given sandboxId. */
async function tokenFor(sandboxId: string): Promise<string> {
  return deriveGatewayToken(sandboxId, SECRET);
}

/** Helper to create a conversation + optionally a message as a user.
 *  Registers the message create handler directly with a mock-auth app so we
 *  don't need a real JWT. */
async function setupData(suffix: string) {
  const userId = `user-${suffix}`;
  const sandboxId = `sandbox-${suffix}`;

  grantSandbox(userId, sandboxId);

  // Minimal app with mock auth for setup
  const setupAppBase = new Hono<{ Bindings: Env; Variables: AuthContext }>();
  setupAppBase.use('*', async (c, next) => {
    c.set('callerId', userId);
    c.set('callerKind', 'user');
    await next();
  });
  registerConversationRoutes(setupAppBase);
  setupAppBase.post('/v1/messages', handleCreateMessage);
  const setupApp = withTestExecutionCtx(setupAppBase);

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
});

// ─── POST .../messages/:messageId/delivery-failed ──────────────────────────

describe('POST /bot/v1/sandboxes/:sandboxId/.../messages/:messageId/delivery-failed', () => {
  it('flips deliveryFailed and returns 202', async () => {
    const { sandboxId, conversationId, messageId, testEnv } = await setupData('bot-msg-df-ok');
    const app = makeBotApp();
    const token = await tokenFor(sandboxId);

    const res = await app.request(
      `/bot/v1/sandboxes/${sandboxId}/conversations/${conversationId}/messages/${messageId}/delivery-failed`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ reason: 'boom' }),
      },
      testEnv
    );
    expect(res.status).toBe(202);

    // second call is idempotent (UPDATE is a no-op)
    const second = await app.request(
      `/bot/v1/sandboxes/${sandboxId}/conversations/${conversationId}/messages/${messageId}/delivery-failed`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: '{}',
      },
      testEnv
    );
    expect(second.status).toBe(202);
  });

  it('returns 401 without auth token', async () => {
    const { sandboxId, conversationId, messageId, testEnv } = await setupData('bot-msg-df-noauth');
    const app = makeBotApp();

    const res = await app.request(
      `/bot/v1/sandboxes/${sandboxId}/conversations/${conversationId}/messages/${messageId}/delivery-failed`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      },
      testEnv
    );
    expect(res.status).toBe(401);
  });
});

// ─── POST .../actions/:groupId/delivery-failed ─────────────────────────────

describe('POST /bot/v1/sandboxes/:sandboxId/.../actions/:groupId/delivery-failed', () => {
  async function setupWithResolvedAction(suffix: string) {
    const userId = `user-${suffix}`;
    const sandboxId = `sandbox-${suffix}`;
    grantSandbox(userId, sandboxId);

    const setupAppBase = new Hono<{ Bindings: Env; Variables: AuthContext }>();
    // user app for conv + message creation
    setupAppBase.use('*', async (c, next) => {
      c.set('callerId', userId);
      c.set('callerKind', 'user');
      await next();
    });
    registerConversationRoutes(setupAppBase);
    setupAppBase.post('/v1/messages', handleCreateMessage);
    setupAppBase.post(
      '/v1/conversations/:conversationId/messages/:messageId/execute-action',
      handleExecuteAction
    );
    const setupApp = withTestExecutionCtx(setupAppBase);

    const testEnv = makeEnv();

    const convRes = await setupApp.request(
      '/v1/conversations',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sandboxId, title: 'Actions' }),
      },
      testEnv
    );
    const { conversationId } = await convRes.json<{ conversationId: string }>();

    // bot creates a message with an actions block
    const botApp = makeBotApp();
    const token = await tokenFor(sandboxId);
    const msgRes = await botApp.request(
      `/bot/v1/sandboxes/${sandboxId}/messages`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({
          conversationId,
          content: [
            {
              type: 'actions',
              groupId: 'g1',
              actions: [{ value: 'allow-once', label: 'Allow', style: 'primary' }],
            },
          ],
        }),
      },
      testEnv
    );
    expect(msgRes.status).toBe(201);
    const { messageId } = await msgRes.json<{ messageId: string }>();

    // user resolves the action
    const execRes = await setupApp.request(
      `/v1/conversations/${conversationId}/messages/${messageId}/execute-action`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ groupId: 'g1', value: 'allow-once' }),
      },
      testEnv
    );
    expect(execRes.status).toBe(200);

    return { sandboxId, conversationId, messageId, testEnv, token };
  }

  it('reverts resolution and returns 202', async () => {
    const { sandboxId, conversationId, messageId, testEnv, token } =
      await setupWithResolvedAction('bot-act-df-ok');
    const app = makeBotApp();

    const res = await app.request(
      `/bot/v1/sandboxes/${sandboxId}/conversations/${conversationId}/actions/g1/delivery-failed`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ messageId }),
      },
      testEnv
    );
    expect(res.status).toBe(202);
  });

  it('is idempotent when already unresolved', async () => {
    const { sandboxId, conversationId, messageId, testEnv, token } =
      await setupWithResolvedAction('bot-act-df-idem');
    const app = makeBotApp();

    const first = await app.request(
      `/bot/v1/sandboxes/${sandboxId}/conversations/${conversationId}/actions/g1/delivery-failed`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ messageId }),
      },
      testEnv
    );
    expect(first.status).toBe(202);

    const second = await app.request(
      `/bot/v1/sandboxes/${sandboxId}/conversations/${conversationId}/actions/g1/delivery-failed`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ messageId }),
      },
      testEnv
    );
    expect(second.status).toBe(202);
  });

  it('returns 400 for missing messageId body', async () => {
    const { sandboxId, conversationId, testEnv, token } =
      await setupWithResolvedAction('bot-act-df-badbody');
    const app = makeBotApp();

    const res = await app.request(
      `/bot/v1/sandboxes/${sandboxId}/conversations/${conversationId}/actions/g1/delivery-failed`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: '{}',
      },
      testEnv
    );
    expect(res.status).toBe(400);
  });

  it('returns 404 when message is unknown', async () => {
    const { sandboxId, conversationId, testEnv, token } =
      await setupWithResolvedAction('bot-act-df-missing');
    const app = makeBotApp();

    const res = await app.request(
      `/bot/v1/sandboxes/${sandboxId}/conversations/${conversationId}/actions/g1/delivery-failed`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ messageId: '00000000000000000000000000' }),
      },
      testEnv
    );
    expect(res.status).toBe(404);
  });

  it('returns 401 without auth', async () => {
    const { sandboxId, conversationId, messageId, testEnv } =
      await setupWithResolvedAction('bot-act-df-noauth');
    const app = makeBotApp();

    const res = await app.request(
      `/bot/v1/sandboxes/${sandboxId}/conversations/${conversationId}/actions/g1/delivery-failed`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messageId }),
      },
      testEnv
    );
    expect(res.status).toBe(401);
  });
});

describe('POST /bot/v1/sandboxes/:sandboxId/messages (auth edge cases)', () => {
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

    const qs = new URLSearchParams({ conversationId });
    const delRes = await app.request(
      `/bot/v1/sandboxes/${sandboxId}/messages/${messageId}?${qs.toString()}`,
      {
        method: 'DELETE',
        headers: { authorization: `Bearer ${token}` },
      },
      testEnv
    );

    expect(delRes.status).toBe(204);
  });

  it('returns 404 for non-existent message', async () => {
    const { sandboxId, conversationId, testEnv } = await setupData('bot-del-notfound');
    const app = makeBotApp();
    const token = await tokenFor(sandboxId);

    const qs = new URLSearchParams({ conversationId });
    const res = await app.request(
      `/bot/v1/sandboxes/${sandboxId}/messages/01ARZ3NDEKTSV4RRFFQ69G5FAV?${qs.toString()}`,
      {
        method: 'DELETE',
        headers: { authorization: `Bearer ${token}` },
      },
      testEnv
    );

    expect(res.status).toBe(404);
  });

  it("returns 403 when deleting another user's message", async () => {
    const { sandboxId, conversationId, messageId, testEnv } = await setupData('bot-del-forbidden');
    const app = makeBotApp();
    const token = await tokenFor(sandboxId);

    const qs = new URLSearchParams({ conversationId });
    const delRes = await app.request(
      `/bot/v1/sandboxes/${sandboxId}/messages/${messageId}?${qs.toString()}`,
      {
        method: 'DELETE',
        headers: { authorization: `Bearer ${token}` },
      },
      testEnv
    );

    expect(delRes.status).toBe(403);
  });

  it('returns 400 for invalid messageId', async () => {
    const { sandboxId, conversationId, testEnv } = await setupData('bot-del-badid');
    const app = makeBotApp();
    const token = await tokenFor(sandboxId);

    const qs = new URLSearchParams({ conversationId });
    const res = await app.request(
      `/bot/v1/sandboxes/${sandboxId}/messages/bad-id?${qs.toString()}`,
      {
        method: 'DELETE',
        headers: { authorization: `Bearer ${token}` },
      },
      testEnv
    );

    expect(res.status).toBe(400);
  });

  it('returns 400 when conversationId query param is missing', async () => {
    const { sandboxId, testEnv } = await setupData('bot-del-nobody');
    const app = makeBotApp();
    const token = await tokenFor(sandboxId);

    const res = await app.request(
      `/bot/v1/sandboxes/${sandboxId}/messages/01ARZ3NDEKTSV4RRFFQ69G5FAV`,
      {
        method: 'DELETE',
        headers: { authorization: `Bearer ${token}` },
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
    const body = await res.json<{
      members: { id: string; kind: string; displayName: string | null; avatarUrl: string | null }[];
    }>();
    expect(Array.isArray(body.members)).toBe(true);
    // Should contain the user (created the conversation) and the bot (sandboxId)
    const ids = body.members.map(m => m.id);
    expect(ids).toContain(`user-bot-members-1`);
    expect(ids).toContain(`bot:kiloclaw:${sandboxId}`);
    for (const member of body.members) {
      expect(member).toHaveProperty('displayName');
      expect(member).toHaveProperty('avatarUrl');
    }
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
  it('returns 204 after removing a reaction via query params', async () => {
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

    const qs = new URLSearchParams({ conversationId, emoji: '👍' });
    const res = await app.request(
      `/bot/v1/sandboxes/${sandboxId}/messages/${messageId}/reactions?${qs.toString()}`,
      {
        method: 'DELETE',
        headers: { authorization: `Bearer ${token}` },
      },
      testEnv
    );

    expect(res.status).toBe(204);
  });

  it('returns 204 even when reaction never existed (idempotent)', async () => {
    const { sandboxId, conversationId, messageId, testEnv } = await setupData('bot-rx-del-idem');
    const app = makeBotApp();
    const token = await tokenFor(sandboxId);

    const qs = new URLSearchParams({ conversationId, emoji: '❤️' });
    const res = await app.request(
      `/bot/v1/sandboxes/${sandboxId}/messages/${messageId}/reactions?${qs.toString()}`,
      {
        method: 'DELETE',
        headers: { authorization: `Bearer ${token}` },
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

    const qs = new URLSearchParams({ conversationId, emoji: '👍' });
    const res = await app.request(
      `/bot/v1/sandboxes/${otherSandboxId}/messages/${messageId}/reactions?${qs.toString()}`,
      {
        method: 'DELETE',
        headers: { authorization: `Bearer ${token}` },
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

// ─── PATCH /bot/v1/sandboxes/:sandboxId/conversations/:conversationId ────────

describe('PATCH /bot/v1/sandboxes/:sandboxId/conversations/:conversationId', () => {
  it('renames a conversation as a member bot (200)', async () => {
    const { sandboxId, conversationId, testEnv } = await setupData('bot-rename-ok');
    const app = makeBotApp();
    const token = await tokenFor(sandboxId);

    const res = await app.request(
      `/bot/v1/sandboxes/${sandboxId}/conversations/${conversationId}`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ title: 'New Title From Bot' }),
      },
      testEnv
    );

    expect(res.status).toBe(200);
    const body = await res.json<{ ok: boolean }>();
    expect(body.ok).toBe(true);
  });

  it('returns 400 for invalid conversation ID', async () => {
    const { sandboxId, testEnv } = await setupData('bot-rename-badid');
    const app = makeBotApp();
    const token = await tokenFor(sandboxId);

    const res = await app.request(
      `/bot/v1/sandboxes/${sandboxId}/conversations/not-a-ulid`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ title: 'Title' }),
      },
      testEnv
    );

    expect(res.status).toBe(400);
  });

  it('returns 400 for missing title', async () => {
    const { sandboxId, conversationId, testEnv } = await setupData('bot-rename-notitle');
    const app = makeBotApp();
    const token = await tokenFor(sandboxId);

    const res = await app.request(
      `/bot/v1/sandboxes/${sandboxId}/conversations/${conversationId}`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({}),
      },
      testEnv
    );

    expect(res.status).toBe(400);
  });

  it('returns 400 for empty title', async () => {
    const { sandboxId, conversationId, testEnv } = await setupData('bot-rename-empty');
    const app = makeBotApp();
    const token = await tokenFor(sandboxId);

    const res = await app.request(
      `/bot/v1/sandboxes/${sandboxId}/conversations/${conversationId}`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ title: '' }),
      },
      testEnv
    );

    expect(res.status).toBe(400);
  });

  it('returns 403 for non-member bot', async () => {
    const { conversationId, testEnv } = await setupData('bot-rename-forbidden');
    const otherSandboxId = 'other-sandbox-rename';
    const app = makeBotApp();
    const token = await tokenFor(otherSandboxId);

    const res = await app.request(
      `/bot/v1/sandboxes/${otherSandboxId}/conversations/${conversationId}`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ title: 'Hijack Title' }),
      },
      testEnv
    );

    expect(res.status).toBe(403);
  });

  it('returns 400 for invalid JSON', async () => {
    const { sandboxId, conversationId, testEnv } = await setupData('bot-rename-badjson');
    const app = makeBotApp();
    const token = await tokenFor(sandboxId);

    const res = await app.request(
      `/bot/v1/sandboxes/${sandboxId}/conversations/${conversationId}`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: 'not-json',
      },
      testEnv
    );

    expect(res.status).toBe(400);
  });

  it('returns 401 without auth token', async () => {
    const { sandboxId, conversationId, testEnv } = await setupData('bot-rename-noauth');
    const app = makeBotApp();

    const res = await app.request(
      `/bot/v1/sandboxes/${sandboxId}/conversations/${conversationId}`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'No Auth' }),
      },
      testEnv
    );

    expect(res.status).toBe(401);
  });
});

// ─── GET /bot/v1/sandboxes/:sandboxId/conversations ─────────────────────────

describe('GET /bot/v1/sandboxes/:sandboxId/conversations', () => {
  it('returns conversations the bot is a member of (200)', async () => {
    const { sandboxId, conversationId, testEnv } = await setupData('bot-list-convs-1');
    const app = makeBotApp();
    const token = await tokenFor(sandboxId);

    const res = await app.request(
      `/bot/v1/sandboxes/${sandboxId}/conversations`,
      {
        method: 'GET',
        headers: { authorization: `Bearer ${token}` },
      },
      testEnv
    );

    expect(res.status).toBe(200);
    const body = await res.json<{
      conversations: Array<{ conversationId: string; title: string | null }>;
      hasMore: boolean;
    }>();
    expect(body.hasMore).toBe(false);
    expect(body.conversations.some(c => c.conversationId === conversationId)).toBe(true);
  });

  it('returns 401 without auth', async () => {
    const { sandboxId, testEnv } = await setupData('bot-list-convs-noauth');
    const app = makeBotApp();

    const res = await app.request(
      `/bot/v1/sandboxes/${sandboxId}/conversations`,
      { method: 'GET' },
      testEnv
    );

    expect(res.status).toBe(401);
  });

  it('respects limit and cursor query params', async () => {
    const { sandboxId, testEnv } = await setupData('bot-list-convs-page');
    const app = makeBotApp();
    const token = await tokenFor(sandboxId);

    const res = await app.request(
      `/bot/v1/sandboxes/${sandboxId}/conversations?limit=1`,
      {
        method: 'GET',
        headers: { authorization: `Bearer ${token}` },
      },
      testEnv
    );

    expect(res.status).toBe(200);
    const body = await res.json<{
      conversations: unknown[];
      hasMore: boolean;
      nextCursor: string | null;
    }>();
    expect(body.conversations.length).toBeLessThanOrEqual(1);
    expect(typeof body.hasMore).toBe('boolean');
  });
});

// ─── POST /bot/v1/sandboxes/:sandboxId/conversations ────────────────────────

describe('POST /bot/v1/sandboxes/:sandboxId/conversations', () => {
  it('creates a conversation with sandbox owner as implicit member (201)', async () => {
    const suffix = 'bot-create-conv-ok';
    const userId = `user-${suffix}`;
    const sandboxId = `sandbox-${suffix}`;
    grantSandbox(userId, sandboxId);

    const app = makeBotApp();
    const token = await tokenFor(sandboxId);
    const testEnv = makeEnv();

    const res = await app.request(
      `/bot/v1/sandboxes/${sandboxId}/conversations`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ title: 'Bot Created Chat' }),
      },
      testEnv
    );

    expect(res.status).toBe(201);
    const body = await res.json<{ conversationId: string }>();
    expect(body.conversationId).toMatch(/^[0-9A-Z]{26}$/);
  });

  it('creates a conversation without title (201)', async () => {
    const suffix = 'bot-create-conv-notitle';
    const userId = `user-${suffix}`;
    const sandboxId = `sandbox-${suffix}`;
    grantSandbox(userId, sandboxId);

    const app = makeBotApp();
    const token = await tokenFor(sandboxId);
    const testEnv = makeEnv();

    const res = await app.request(
      `/bot/v1/sandboxes/${sandboxId}/conversations`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({}),
      },
      testEnv
    );

    expect(res.status).toBe(201);
  });

  it('returns 401 without auth', async () => {
    const suffix = 'bot-create-conv-noauth';
    const sandboxId = `sandbox-${suffix}`;
    const app = makeBotApp();
    const testEnv = makeEnv();

    const res = await app.request(
      `/bot/v1/sandboxes/${sandboxId}/conversations`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'X' }),
      },
      testEnv
    );

    expect(res.status).toBe(401);
  });

  it('returns 404 when sandbox has no owner', async () => {
    const sandboxId = 'sandbox-no-owner';
    // Don't call grantSandbox — no owner exists
    const app = makeBotApp();
    const token = await tokenFor(sandboxId);
    const testEnv = makeEnv();

    const res = await app.request(
      `/bot/v1/sandboxes/${sandboxId}/conversations`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ title: 'Ghost' }),
      },
      testEnv
    );

    expect(res.status).toBe(404);
  });

  it('returns 400 for invalid JSON', async () => {
    const suffix = 'bot-create-conv-badjson';
    const sandboxId = `sandbox-${suffix}`;
    grantSandbox(`user-${suffix}`, sandboxId);

    const app = makeBotApp();
    const token = await tokenFor(sandboxId);
    const testEnv = makeEnv();

    const res = await app.request(
      `/bot/v1/sandboxes/${sandboxId}/conversations`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: 'not-json',
      },
      testEnv
    );

    expect(res.status).toBe(400);
  });
});
