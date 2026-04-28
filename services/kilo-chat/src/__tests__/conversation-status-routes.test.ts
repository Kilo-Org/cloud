import { env } from 'cloudflare:test';
import { describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';
import type { AuthContext } from '../auth';
import { botAuthMiddleware } from '../auth-bot';
import { registerBotRoutes } from '../routes/bot-messages';
import { registerConversationRoutes } from '../routes/conversations';
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
function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    ...env,
    GATEWAY_TOKEN_SECRET: { get: () => Promise.resolve(SECRET) },
    ...overrides,
  } as unknown as Env;
}

/** App with bot auth middleware + bot routes. */
function makeBotApp() {
  const app = new Hono<{ Bindings: Env; Variables: AuthContext }>();
  app.use('/bot/v1/sandboxes/:sandboxId/*', botAuthMiddleware);
  registerBotRoutes(app);
  return withTestExecutionCtx(app);
}

async function tokenFor(sandboxId: string): Promise<string> {
  return deriveGatewayToken(sandboxId, SECRET);
}

/** Provision a sandbox + conversation owned by `user-${suffix}` where the
 *  bot for `sandbox-${suffix}` is a member. Returns identifiers + a base
 *  test env (no EVENT_SERVICE override). */
async function setupConversation(suffix: string) {
  const userId = `user-${suffix}`;
  const sandboxId = `sandbox-${suffix}`;
  grantSandbox(userId, sandboxId);

  const setupAppBase = new Hono<{ Bindings: Env; Variables: AuthContext }>();
  setupAppBase.use('*', async (c, next) => {
    c.set('callerId', userId);
    c.set('callerKind', 'user');
    await next();
  });
  registerConversationRoutes(setupAppBase);
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

  return { userId, sandboxId, conversationId };
}

const VALID_BODY = {
  contextTokens: 1234,
  contextWindow: 200000,
  model: 'claude-opus-4-7',
  provider: 'anthropic',
  at: 1700000000000,
};

describe('POST /bot/v1/sandboxes/:sandboxId/conversations/:cid/conversation-status', () => {
  it('returns 401 without auth token', async () => {
    const { sandboxId, conversationId } = await setupConversation('cv-status-noauth');
    const app = makeBotApp();
    const testEnv = makeEnv();

    const res = await app.request(
      `/bot/v1/sandboxes/${sandboxId}/conversations/${conversationId}/conversation-status`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(VALID_BODY),
      },
      testEnv
    );

    expect(res.status).toBe(401);
  });

  it('rejects invalid JSON with 400', async () => {
    const { sandboxId, conversationId } = await setupConversation('cv-status-badjson');
    const app = makeBotApp();
    const token = await tokenFor(sandboxId);
    const testEnv = makeEnv();

    const res = await app.request(
      `/bot/v1/sandboxes/${sandboxId}/conversations/${conversationId}/conversation-status`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: 'not-json',
      },
      testEnv
    );

    expect(res.status).toBe(400);
  });

  it('rejects invalid body shape with 400', async () => {
    const { sandboxId, conversationId } = await setupConversation('cv-status-badshape');
    const app = makeBotApp();
    const token = await tokenFor(sandboxId);
    const testEnv = makeEnv();

    const res = await app.request(
      `/bot/v1/sandboxes/${sandboxId}/conversations/${conversationId}/conversation-status`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ contextTokens: 1, at: 1 }), // missing required fields
      },
      testEnv
    );

    expect(res.status).toBe(400);
  });

  it('rejects invalid conversationId param with 400', async () => {
    const { sandboxId } = await setupConversation('cv-status-badcid');
    const app = makeBotApp();
    const token = await tokenFor(sandboxId);
    const testEnv = makeEnv();

    const res = await app.request(
      `/bot/v1/sandboxes/${sandboxId}/conversations/not-a-ulid/conversation-status`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify(VALID_BODY),
      },
      testEnv
    );

    expect(res.status).toBe(400);
  });

  it('returns 404 for unknown conversation', async () => {
    const suffix = 'cv-status-unknown';
    const sandboxId = `sandbox-${suffix}`;
    grantSandbox(`user-${suffix}`, sandboxId);

    const app = makeBotApp();
    const token = await tokenFor(sandboxId);
    const testEnv = makeEnv();

    const res = await app.request(
      `/bot/v1/sandboxes/${sandboxId}/conversations/01ARZ3NDEKTSV4RRFFQ69G5FAV/conversation-status`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify(VALID_BODY),
      },
      testEnv
    );

    expect(res.status).toBe(404);
  });

  it('returns 403 when conversation belongs to a different sandbox', async () => {
    const { conversationId } = await setupConversation('cv-status-otherbox');
    // Use a different sandbox than the one that owns the conversation.
    const otherSandboxId = 'other-sandbox-cv-status';
    const app = makeBotApp();
    const token = await tokenFor(otherSandboxId);
    const testEnv = makeEnv();

    const res = await app.request(
      `/bot/v1/sandboxes/${otherSandboxId}/conversations/${conversationId}/conversation-status`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify(VALID_BODY),
      },
      testEnv
    );

    expect(res.status).toBe(403);
  });

  it('persists to SandboxStatusDO and emits conversation.status event on success', async () => {
    const { userId, sandboxId, conversationId } = await setupConversation('cv-status-ok');
    const app = makeBotApp();
    const token = await tokenFor(sandboxId);

    const pushEvent = vi.fn().mockResolvedValue(true);
    const testEnv = makeEnv({
      EVENT_SERVICE: { pushEvent },
    } as unknown as Partial<Env>);

    const res = await app.request(
      `/bot/v1/sandboxes/${sandboxId}/conversations/${conversationId}/conversation-status`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify(VALID_BODY),
      },
      testEnv
    );

    expect(res.status).toBe(200);
    const body = await res.json<{ ok: boolean }>();
    expect(body.ok).toBe(true);

    // Assert the event was emitted to the sandbox owner on the conversation
    // context (`/kiloclaw/{sandboxId}/{conversationId}`) with the right
    // event name and payload shape.
    expect(pushEvent).toHaveBeenCalledTimes(1);
    expect(pushEvent).toHaveBeenCalledWith(
      userId,
      `/kiloclaw/${sandboxId}/${conversationId}`,
      'conversation.status',
      {
        conversationId,
        contextTokens: VALID_BODY.contextTokens,
        contextWindow: VALID_BODY.contextWindow,
        model: VALID_BODY.model,
        provider: VALID_BODY.provider,
        at: VALID_BODY.at,
      }
    );

    // Assert the persisted record is readable via SANDBOX_STATUS_DO.
    const stub = testEnv.SANDBOX_STATUS_DO.get(testEnv.SANDBOX_STATUS_DO.idFromName(sandboxId));
    const record = await stub.getConversationStatus(conversationId);
    expect(record).not.toBeNull();
    expect(record).toMatchObject({
      conversationId,
      contextTokens: VALID_BODY.contextTokens,
      contextWindow: VALID_BODY.contextWindow,
      model: VALID_BODY.model,
      provider: VALID_BODY.provider,
      at: VALID_BODY.at,
    });
    expect(typeof record!.updatedAt).toBe('number');
  });

  it('persists with null model/provider', async () => {
    const { sandboxId, conversationId } = await setupConversation('cv-status-nullmodel');
    const app = makeBotApp();
    const token = await tokenFor(sandboxId);

    const pushEvent = vi.fn().mockResolvedValue(true);
    const testEnv = makeEnv({
      EVENT_SERVICE: { pushEvent },
    } as unknown as Partial<Env>);

    const body = {
      contextTokens: 0,
      contextWindow: 0,
      model: null,
      provider: null,
      at: 1700000001000,
    };

    const res = await app.request(
      `/bot/v1/sandboxes/${sandboxId}/conversations/${conversationId}/conversation-status`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      },
      testEnv
    );

    expect(res.status).toBe(200);

    const stub = testEnv.SANDBOX_STATUS_DO.get(testEnv.SANDBOX_STATUS_DO.idFromName(sandboxId));
    const record = await stub.getConversationStatus(conversationId);
    expect(record).not.toBeNull();
    expect(record!.model).toBeNull();
    expect(record!.provider).toBeNull();
  });
});
