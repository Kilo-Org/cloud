import { env } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { createMiddleware } from 'hono/factory';
import type { AuthContext } from '../auth';
import { registerConversationRoutes } from '../routes/conversations';
import { registerTypingRoutes } from '../routes/typing';

function makeApp(callerId: string, callerKind: 'user' | 'bot', allowedSandboxIds: string[] = []) {
  const mockAuth = createMiddleware<{ Bindings: Env; Variables: AuthContext }>(async (c, next) => {
    c.set('callerId', callerId);
    c.set('callerKind', callerKind);
    c.set('allowedSandboxIds', allowedSandboxIds);
    await next();
  });

  const app = new Hono<{ Bindings: Env; Variables: AuthContext }>();
  app.use('/v1/*', mockAuth);
  registerConversationRoutes(app);
  registerTypingRoutes(app);
  return app;
}

async function createConversation(userSuffix: string) {
  const userId = `user-${userSuffix}`;
  const sandboxId = `sandbox-${userSuffix}`;
  const botId = `bot:kiloclaw:${sandboxId}`;

  const userApp = makeApp(userId, 'user', [sandboxId]);
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

describe('POST /v1/conversations/:id/typing', () => {
  it('returns 200 for a member', async () => {
    const { conversationId, userApp } = await createConversation('typing-member');

    const res = await userApp.request(
      `/v1/conversations/${conversationId}/typing`,
      { method: 'POST' },
      env
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({});
  });

  it('returns 403 for a non-member', async () => {
    const { conversationId } = await createConversation('typing-nonmember');
    const strangerApp = makeApp('user-stranger-typing', 'user');

    const res = await strangerApp.request(
      `/v1/conversations/${conversationId}/typing`,
      { method: 'POST' },
      env
    );

    expect(res.status).toBe(403);
    const body = await res.json<{ error: string }>();
    expect(body.error).toBe('Forbidden');
  });
});
