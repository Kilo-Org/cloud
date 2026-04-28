import { env } from 'cloudflare:test';
import { describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';
import type { AuthContext } from '../auth';
import { authMiddleware } from '../auth';
import { registerConversationRoutes } from '../routes/conversations';
import { registerSandboxReadRoutes } from '../routes/sandbox-reads';
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

function makeEnv(): Env {
  return { ...env } as unknown as Env;
}

/** App that wires real human auth + the read routes under test. */
function makeReadApp() {
  const app = new Hono<{ Bindings: Env; Variables: AuthContext }>();
  app.use('/v1/*', authMiddleware);
  registerSandboxReadRoutes(app);
  return withTestExecutionCtx(app);
}

/** App with mock user auth used only to create conversations via the real
 *  conversation routes. Matches the pattern used in conversation-status-routes.test.ts. */
function makeSetupApp(userId: string) {
  const app = new Hono<{ Bindings: Env; Variables: AuthContext }>();
  app.use('*', async (c, next) => {
    c.set('callerId', userId);
    c.set('callerKind', 'user');
    await next();
  });
  registerConversationRoutes(app);
  return withTestExecutionCtx(app);
}

/** Mount the read routes with mocked user auth so we can exercise them with a
 *  given caller identity without minting a real JWT. */
function makeReadAppAs(userId: string) {
  const app = new Hono<{ Bindings: Env; Variables: AuthContext }>();
  app.use('/v1/*', async (c, next) => {
    c.set('callerId', userId);
    c.set('callerKind', 'user');
    await next();
  });
  registerSandboxReadRoutes(app);
  return withTestExecutionCtx(app);
}

async function setupConversation(suffix: string) {
  const userId = `user-${suffix}`;
  const sandboxId = `sandbox-${suffix}`;
  grantSandbox(userId, sandboxId);

  const setupApp = makeSetupApp(userId);
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

describe('GET /v1/sandboxes/:sandboxId/bot-status', () => {
  it('401 when unauthenticated', async () => {
    const app = makeReadApp();
    const res = await app.request('/v1/sandboxes/sandbox-bot-noauth/bot-status', {}, makeEnv());
    expect(res.status).toBe(401);
  });

  it('403 when sandbox does not exist (no owner mapping)', async () => {
    const app = makeReadAppAs('user-missing');
    const res = await app.request('/v1/sandboxes/sandbox-missing/bot-status', {}, makeEnv());
    expect(res.status).toBe(403);
  });

  it('403 when caller is not the sandbox owner', async () => {
    grantSandbox('user-owner-bot', 'sandbox-owned-bot');
    const app = makeReadAppAs('user-other-bot');
    const res = await app.request('/v1/sandboxes/sandbox-owned-bot/bot-status', {}, makeEnv());
    expect(res.status).toBe(403);
  });

  it('200 with { status: null } when no heartbeat has been written', async () => {
    grantSandbox('user-bot-empty', 'sandbox-bot-empty');
    const app = makeReadAppAs('user-bot-empty');
    const res = await app.request('/v1/sandboxes/sandbox-bot-empty/bot-status', {}, makeEnv());
    expect(res.status).toBe(200);
    const body = await res.json<{ status: unknown }>();
    expect(body.status).toBeNull();
  });

  it('200 with the persisted record after a write', async () => {
    grantSandbox('user-bot-filled', 'sandbox-bot-filled');
    const testEnv = makeEnv();
    const stub = testEnv.SANDBOX_STATUS_DO.get(
      testEnv.SANDBOX_STATUS_DO.idFromName('sandbox-bot-filled')
    );
    await stub.putBotStatus({ online: true, at: 1700000000000 });

    const app = makeReadAppAs('user-bot-filled');
    const res = await app.request('/v1/sandboxes/sandbox-bot-filled/bot-status', {}, testEnv);
    expect(res.status).toBe(200);
    const body = await res.json<{ status: { online: boolean; at: number; updatedAt: number } }>();
    expect(body.status).not.toBeNull();
    expect(body.status.online).toBe(true);
    expect(body.status.at).toBe(1700000000000);
    expect(typeof body.status.updatedAt).toBe('number');
  });
});

describe('POST /v1/sandboxes/:sandboxId/request-bot-status', () => {
  type RecordingKiloclaw = typeof env.KILOCLAW & {
    __recordedWebhookCalls(): Promise<Array<Record<string, unknown>>>;
    __clearWebhookCalls(): Promise<void>;
  };
  const recordingKiloclaw = env.KILOCLAW as RecordingKiloclaw;

  it('401 when unauthenticated', async () => {
    const app = makeReadApp();
    const res = await app.request(
      '/v1/sandboxes/sandbox-req-noauth/request-bot-status',
      { method: 'POST' },
      makeEnv()
    );
    expect(res.status).toBe(401);
  });

  it('403 when caller does not own the sandbox', async () => {
    grantSandbox('user-req-owner', 'sandbox-req-owned');
    const app = makeReadAppAs('user-req-other');
    const res = await app.request(
      '/v1/sandboxes/sandbox-req-owned/request-bot-status',
      { method: 'POST' },
      makeEnv()
    );
    expect(res.status).toBe(403);
  });

  it('fires the bot.status_request webhook when no fresh cache exists', async () => {
    grantSandbox('user-req-fresh', 'sandbox-req-fresh');
    await recordingKiloclaw.__clearWebhookCalls();

    const app = makeReadAppAs('user-req-fresh');
    const res = await app.request(
      '/v1/sandboxes/sandbox-req-fresh/request-bot-status',
      { method: 'POST' },
      makeEnv()
    );
    expect(res.status).toBe(200);

    const calls = await recordingKiloclaw.__recordedWebhookCalls();
    const myCalls = calls.filter(c => c.targetBotId === 'bot:kiloclaw:sandbox-req-fresh');
    expect(myCalls).toHaveLength(1);
    expect(myCalls[0]).toMatchObject({
      type: 'bot.status_request',
      targetBotId: 'bot:kiloclaw:sandbox-req-fresh',
    });
  });

  it('skips the webhook when cached status is fresh (dedupe)', async () => {
    grantSandbox('user-req-dedupe', 'sandbox-req-dedupe');
    const testEnv = makeEnv();
    const stub = testEnv.SANDBOX_STATUS_DO.get(
      testEnv.SANDBOX_STATUS_DO.idFromName('sandbox-req-dedupe')
    );
    // putBotStatus stamps `updatedAt = Date.now()`, which by definition is
    // within the FRESH_STATUS_TTL_MS window when the request below runs.
    await stub.putBotStatus({ online: true, at: Date.now() });
    await recordingKiloclaw.__clearWebhookCalls();

    const app = makeReadAppAs('user-req-dedupe');
    const res = await app.request(
      '/v1/sandboxes/sandbox-req-dedupe/request-bot-status',
      { method: 'POST' },
      testEnv
    );
    expect(res.status).toBe(200);
    const body = await res.json<{ ok: boolean; dedupe?: string }>();
    expect(body.dedupe).toBe('fresh');

    const calls = await recordingKiloclaw.__recordedWebhookCalls();
    const myCalls = calls.filter(c => c.targetBotId === 'bot:kiloclaw:sandbox-req-dedupe');
    expect(myCalls).toHaveLength(0);
  });
});

describe('GET /v1/conversations/:conversationId/conversation-status', () => {
  it('401 when unauthenticated', async () => {
    const app = makeReadApp();
    const res = await app.request(
      '/v1/conversations/01ARZ3NDEKTSV4RRFFQ69G5FAV/conversation-status',
      {},
      makeEnv()
    );
    expect(res.status).toBe(401);
  });

  it('403 when caller is not a member of the conversation', async () => {
    const { conversationId } = await setupConversation('cv-read-forbidden');
    const app = makeReadAppAs('user-not-member');
    const res = await app.request(
      `/v1/conversations/${conversationId}/conversation-status`,
      {},
      makeEnv()
    );
    expect(res.status).toBe(403);
  });

  it('200 with { status: null } when no post-turn has been written', async () => {
    const { userId, conversationId } = await setupConversation('cv-read-empty');
    const app = makeReadAppAs(userId);
    const res = await app.request(
      `/v1/conversations/${conversationId}/conversation-status`,
      {},
      makeEnv()
    );
    expect(res.status).toBe(200);
    const body = await res.json<{ status: unknown }>();
    expect(body.status).toBeNull();
  });

  it('200 with the persisted record after a write', async () => {
    const { userId, sandboxId, conversationId } = await setupConversation('cv-read-filled');
    const testEnv = makeEnv();
    const stub = testEnv.SANDBOX_STATUS_DO.get(testEnv.SANDBOX_STATUS_DO.idFromName(sandboxId));
    await stub.putConversationStatus({
      conversationId,
      contextTokens: 500,
      contextWindow: 200000,
      model: 'claude-opus-4-7',
      provider: 'anthropic',
      at: 1700000001000,
    });

    const app = makeReadAppAs(userId);
    const res = await app.request(
      `/v1/conversations/${conversationId}/conversation-status`,
      {},
      testEnv
    );
    expect(res.status).toBe(200);
    const body = await res.json<{
      status: {
        conversationId: string;
        contextTokens: number;
        contextWindow: number;
        model: string | null;
        provider: string | null;
        at: number;
        updatedAt: number;
      };
    }>();
    expect(body.status).not.toBeNull();
    expect(body.status).toMatchObject({
      conversationId,
      contextTokens: 500,
      contextWindow: 200000,
      model: 'claude-opus-4-7',
      provider: 'anthropic',
      at: 1700000001000,
    });
    expect(typeof body.status.updatedAt).toBe('number');
  });
});
