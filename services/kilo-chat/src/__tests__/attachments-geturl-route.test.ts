import { env } from 'cloudflare:test';
import { describe, it, expect, vi } from 'vitest';
import { ulid } from 'ulid';
import { Hono } from 'hono';
import type { AuthContext } from '../auth';
import { botAuthMiddleware } from '../auth-bot';
import { registerBotRoutes } from '../routes/bot-messages';
import { registerConversationRoutes } from '../routes/conversations';
import { handleAttachmentGetUrl } from '../routes/handler';
import { deriveGatewayToken } from '../lib/gateway-token';
import type { ConversationDO } from '../do/conversation-do';
import { makeApp, putUploadedAttachmentObject, unwrap, withTestExecutionCtx } from './helpers';

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
  const app = makeApp(callerId, 'user');
  app.get('/v1/attachments/:id/url', handleAttachmentGetUrl);
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

function getConvStub(conversationId: string): DurableObjectStub<ConversationDO> {
  return env.CONVERSATION_DO.get(env.CONVERSATION_DO.idFromName(conversationId));
}

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

async function seedLinkedAttachment(
  conversationId: string,
  uploaderId: string,
  opts: { mimeType: string; filename: string; size: number }
): Promise<{ attachmentId: string }> {
  const stub = getConvStub(conversationId);
  const init = await unwrap(
    stub.initAttachment({
      uploaderId,
      mimeType: opts.mimeType,
      size: opts.size,
      filename: opts.filename,
    })
  );
  await putUploadedAttachmentObject({
    r2Key: init.r2Key,
    size: opts.size,
    mimeType: opts.mimeType,
  });
  const result = await stub.createMessage({
    senderId: uploaderId,
    content: [
      {
        type: 'attachment',
        attachmentId: init.attachmentId,
        mimeType: opts.mimeType,
        size: opts.size,
        filename: opts.filename,
      },
    ],
  });
  expect(result.ok).toBe(true);
  return { attachmentId: init.attachmentId };
}

async function seedPendingAttachment(
  conversationId: string,
  uploaderId: string
): Promise<{ attachmentId: string }> {
  const stub = getConvStub(conversationId);
  const init = await unwrap(
    stub.initAttachment({
      uploaderId,
      mimeType: 'image/png',
      size: 1,
      filename: 'pending.png',
    })
  );
  return { attachmentId: init.attachmentId };
}

describe('GET /v1/attachments/:id/url (user)', () => {
  it('returns a signed GET url for a linked attachment owned by the member', async () => {
    const { userId, conversationId, testEnv } = await setupConversation('att-get-ok');
    const { attachmentId } = await seedLinkedAttachment(conversationId, userId, {
      mimeType: 'image/png',
      filename: 'pic.png',
      size: 1234,
    });
    const userApp = makeUserApp(userId);

    const res = await userApp.request(
      `/v1/attachments/${attachmentId}/url?conversationId=${conversationId}`,
      {},
      testEnv
    );
    expect(res.status).toBe(200);
    const body = await res.json<{
      url: string;
      mimeType: string;
      size: number;
      filename: string;
      expiresAt: number;
    }>();
    expect(body.url).toContain('.r2.cloudflarestorage.com/');
    expect(body.url).toContain('X-Amz-Expires=3600');
    // image/* → inline (no response-content-disposition override)
    expect(decodeURIComponent(body.url)).not.toContain('response-content-disposition');
    expect(body.mimeType).toBe('image/png');
    expect(body.size).toBe(1234);
    expect(body.filename).toBe('pic.png');
    const nowSec = Math.floor(Date.now() / 1000);
    expect(body.expiresAt).toBeGreaterThan(nowSec + 3000);
    expect(body.expiresAt).toBeLessThanOrEqual(nowSec + 3600);
  });

  it('forces download disposition for non-image mime types', async () => {
    const { userId, conversationId, testEnv } = await setupConversation('att-get-pdf');
    const { attachmentId } = await seedLinkedAttachment(conversationId, userId, {
      mimeType: 'application/pdf',
      filename: 'doc.pdf',
      size: 100,
    });
    const userApp = makeUserApp(userId);

    const res = await userApp.request(
      `/v1/attachments/${attachmentId}/url?conversationId=${conversationId}`,
      {},
      testEnv
    );
    expect(res.status).toBe(200);
    const body = await res.json<{ url: string }>();
    expect(decodeURIComponent(body.url)).toContain('response-content-disposition=attachment');
    expect(decodeURIComponent(body.url)).toContain('doc.pdf');
  });

  it('returns 404 for a pending attachment that has no linked message', async () => {
    const { userId, conversationId, testEnv } = await setupConversation('att-get-pending');
    const { attachmentId } = await seedPendingAttachment(conversationId, userId);
    const userApp = makeUserApp(userId);

    const res = await userApp.request(
      `/v1/attachments/${attachmentId}/url?conversationId=${conversationId}`,
      {},
      testEnv
    );
    expect(res.status).toBe(404);
  });

  it('returns 403 when requester is not a conversation member', async () => {
    const { userId, conversationId, testEnv } = await setupConversation('att-get-stranger');
    const { attachmentId } = await seedLinkedAttachment(conversationId, userId, {
      mimeType: 'image/png',
      filename: 'pic.png',
      size: 10,
    });
    const strangerApp = makeUserApp('user-stranger-att-get');

    const res = await strangerApp.request(
      `/v1/attachments/${attachmentId}/url?conversationId=${conversationId}`,
      {},
      testEnv
    );
    expect(res.status).toBe(403);
  });

  it('returns 400 without conversationId query param', async () => {
    const { userId, testEnv } = await setupConversation('att-get-noconv');
    const userApp = makeUserApp(userId);
    const res = await userApp.request(`/v1/attachments/${ulid()}/url`, {}, testEnv);
    expect(res.status).toBe(400);
  });

  it('returns 400 when attachmentId is not a valid ULID', async () => {
    const { userId, conversationId, testEnv } = await setupConversation('att-get-bad-id');
    const userApp = makeUserApp(userId);
    const res = await userApp.request(
      `/v1/attachments/not-a-ulid/url?conversationId=${conversationId}`,
      {},
      testEnv
    );
    expect(res.status).toBe(400);
  });
});

describe('GET /bot/v1/sandboxes/:sandboxId/attachments/:id/url (bot)', () => {
  it('returns a signed GET url for a member bot', async () => {
    const { userId, sandboxId, conversationId, testEnv } = await setupConversation('att-get-bot');
    const { attachmentId } = await seedLinkedAttachment(conversationId, userId, {
      mimeType: 'image/png',
      filename: 'bot.png',
      size: 256,
    });
    const app = makeBotApp();
    const token = await tokenFor(sandboxId);

    const res = await app.request(
      `/bot/v1/sandboxes/${sandboxId}/attachments/${attachmentId}/url?conversationId=${conversationId}`,
      { headers: { authorization: `Bearer ${token}` } },
      testEnv
    );
    expect(res.status).toBe(200);
    const body = await res.json<{ url: string; mimeType: string }>();
    expect(body.url).toContain('.r2.cloudflarestorage.com/');
    expect(body.mimeType).toBe('image/png');
  });

  it('rejects bot from sandbox-B reading an attachment from a conversation owned by sandbox-A with 403', async () => {
    const { userId, conversationId, testEnv } = await setupConversation('att-get-bot-xsandbox-a');
    const { attachmentId } = await seedLinkedAttachment(conversationId, userId, {
      mimeType: 'image/png',
      filename: 'secret.png',
      size: 10,
    });
    const sandboxB = 'sandbox-att-get-bot-xsandbox-b';
    const app = makeBotApp();
    const tokenB = await tokenFor(sandboxB);

    const res = await app.request(
      `/bot/v1/sandboxes/${sandboxB}/attachments/${attachmentId}/url?conversationId=${conversationId}`,
      { headers: { authorization: `Bearer ${tokenB}` } },
      testEnv
    );

    expect(res.status).toBe(403);
  });
});
