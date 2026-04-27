import { env } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import { makeApp } from './helpers';

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

describe('POST /v1/conversations/:id/typing', () => {
  it('returns 204 for a member', async () => {
    const { conversationId, userApp } = await createConversation('typing-member');

    const res = await userApp.request(
      `/v1/conversations/${conversationId}/typing`,
      { method: 'POST' },
      env
    );

    expect(res.status).toBe(204);
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
