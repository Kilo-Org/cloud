import { env } from 'cloudflare:test';
import { describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';
import type { AuthContext } from '../auth';
import { botAuthMiddleware } from '../auth-bot';
import { registerBotRoutes } from '../routes/bot-messages';
import { registerConversationRoutes } from '../routes/conversations';
import { handleAttachmentInit } from '../routes/handler';
import { deriveGatewayToken } from '../lib/gateway-token';
import { makeApp, withTestExecutionCtx } from './helpers';

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

const GATEWAY_SECRET = 'test-gateway-secret';
const R2_ACCESS_KEY = 'AKIA-TEST';
const R2_SECRET_KEY = 'SECRET-TEST';

function makeEnv(): Env {
  return {
    ...env,
    GATEWAY_TOKEN_SECRET: { get: () => Promise.resolve(GATEWAY_SECRET) },
    R2_ACCESS_KEY_ID: { get: () => Promise.resolve(R2_ACCESS_KEY) },
    R2_SECRET_ACCESS_KEY: { get: () => Promise.resolve(R2_SECRET_KEY) },
  } as unknown as Env;
}

function makeUserApp(callerId: string) {
  // Reuses the helpers.makeApp pattern but also registers the attachments-init route.
  const app = makeApp(callerId, 'user');
  app.post('/v1/attachments/init', handleAttachmentInit);
  return app;
}

function makeBotApp() {
  const app = new Hono<{ Bindings: Env; Variables: AuthContext }>();
  app.use('/bot/v1/sandboxes/:sandboxId/*', botAuthMiddleware);
  registerBotRoutes(app);
  return withTestExecutionCtx(app);
}

async function tokenFor(sandboxId: string): Promise<string> {
  return deriveGatewayToken(sandboxId, GATEWAY_SECRET);
}

async function createConversationAsUser(suffix: string) {
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
  const res = await setupApp.request(
    '/v1/conversations',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sandboxId, title: `Chat ${suffix}` }),
    },
    testEnv
  );
  expect(res.status).toBe(201);
  const { conversationId } = await res.json<{ conversationId: string }>();
  return { userId, sandboxId, conversationId, testEnv };
}

describe('POST /v1/attachments/init (user)', () => {
  it('returns putUrl + attachmentId for a conversation member', async () => {
    const { userId, conversationId, testEnv } = await createConversationAsUser('att-init-ok');
    const userApp = makeUserApp(userId);

    const res = await userApp.request(
      '/v1/attachments/init',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          conversationId,
          mimeType: 'image/png',
          size: 1024,
          filename: 'pic.png',
        }),
      },
      testEnv
    );

    expect(res.status).toBe(200);
    const body = await res.json<{
      attachmentId: string;
      putUrl: string;
      putHeaders: Record<string, string>;
      putUrlExpiresAt: number;
    }>();
    expect(body.attachmentId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(body.putUrl).toContain('.r2.cloudflarestorage.com/');
    expect(body.putUrl).toContain('X-Amz-Expires=900');
    expect(body.putHeaders['Content-Type']).toBe('image/png');
    expect(body.putHeaders['Content-Length']).toBe('1024');
    const nowSec = Math.floor(Date.now() / 1000);
    expect(body.putUrlExpiresAt).toBeGreaterThan(nowSec + 800);
    expect(body.putUrlExpiresAt).toBeLessThanOrEqual(nowSec + 900);
  });

  it('rejects size > 100 MB with 400', async () => {
    const { userId, conversationId, testEnv } = await createConversationAsUser('att-init-toobig');
    const userApp = makeUserApp(userId);

    const res = await userApp.request(
      '/v1/attachments/init',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          conversationId,
          mimeType: 'image/png',
          size: 101 * 1024 * 1024,
          filename: 'big.png',
        }),
      },
      testEnv
    );
    expect(res.status).toBe(400);
  });

  it('accepts a long multi-byte UTF-8 filename without timing out', async () => {
    const { userId, conversationId, testEnv } = await createConversationAsUser('att-init-utf8');
    const userApp = makeUserApp(userId);

    const filename =
      'very-long-attachment-filename-with-unicode-åß∂ƒ-and-many-segments-for-truncation-check.txt';

    const start = Date.now();
    const res = await userApp.request(
      '/v1/attachments/init',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          conversationId,
          mimeType: 'text/plain',
          size: 21,
          filename,
        }),
      },
      testEnv
    );
    const elapsedMs = Date.now() - start;

    expect(res.status).toBe(200);
    expect(elapsedMs).toBeLessThan(5_000);
    const body = await res.json<{ attachmentId: string; putUrl: string }>();
    expect(body.attachmentId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(body.putUrl).toContain('.r2.cloudflarestorage.com/');
  });

  it('rejects non-member with 403', async () => {
    const { conversationId, testEnv } = await createConversationAsUser('att-init-stranger');
    const strangerApp = makeUserApp('user-stranger-att-init');

    const res = await strangerApp.request(
      '/v1/attachments/init',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          conversationId,
          mimeType: 'image/png',
          size: 100,
          filename: 'a.png',
        }),
      },
      testEnv
    );
    expect(res.status).toBe(403);
  });
});

describe('POST /bot/v1/sandboxes/:sandboxId/attachments/init (bot)', () => {
  it('returns putUrl when bot is a member', async () => {
    const { sandboxId, conversationId, testEnv } = await createConversationAsUser('att-init-bot');
    const app = makeBotApp();
    const token = await tokenFor(sandboxId);

    const res = await app.request(
      `/bot/v1/sandboxes/${sandboxId}/attachments/init`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          conversationId,
          mimeType: 'image/png',
          size: 256,
          filename: 'bot.png',
        }),
      },
      testEnv
    );

    expect(res.status).toBe(200);
    const body = await res.json<{
      attachmentId: string;
      putUrl: string;
      putHeaders: Record<string, string>;
      putUrlExpiresAt: number;
    }>();
    expect(body.attachmentId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(body.putUrl).toContain('.r2.cloudflarestorage.com/');
    expect(body.putHeaders['Content-Type']).toBe('image/png');
    expect(body.putHeaders['Content-Length']).toBe('256');
    expect(typeof body.putUrlExpiresAt).toBe('number');
  });

  it('rejects bot from sandbox-B accessing a conversation owned by sandbox-A with 403', async () => {
    const { conversationId, testEnv } = await createConversationAsUser('att-init-bot-xsandbox-a');
    const sandboxB = 'sandbox-att-init-bot-xsandbox-b';
    const app = makeBotApp();
    const tokenB = await tokenFor(sandboxB);

    const res = await app.request(
      `/bot/v1/sandboxes/${sandboxB}/attachments/init`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${tokenB}`,
        },
        body: JSON.stringify({
          conversationId,
          mimeType: 'image/png',
          size: 100,
          filename: 'x.png',
        }),
      },
      testEnv
    );

    expect(res.status).toBe(403);
  });
});
