import { env } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import { makeApp } from './helpers';

async function setup(suffix: string) {
  const userId = `user-${suffix}`;
  const sandboxId = `sandbox-${suffix}`;
  const botId = `bot:kiloclaw:${sandboxId}`;
  const userApp = makeApp(userId, 'user');

  const convRes = await userApp.request(
    '/v1/conversations',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sandboxId, title: suffix }),
    },
    env
  );
  expect(convRes.status).toBe(201);
  const { conversationId } = await convRes.json<{ conversationId: string }>();

  const msgRes = await userApp.request(
    '/v1/messages',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ conversationId, content: [{ type: 'text', text: 'hello' }] }),
    },
    env
  );
  expect(msgRes.status).toBe(201);
  const { messageId } = await msgRes.json<{ messageId: string }>();

  return { userId, botId, conversationId, messageId, userApp };
}

describe('POST /v1/messages/:id/reactions', () => {
  it('201 on first add, returns { id }', async () => {
    const { conversationId, messageId, userApp } = await setup('rx-post-1');
    const res = await userApp.request(
      `/v1/messages/${messageId}/reactions`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ conversationId, emoji: '👍' }),
      },
      env
    );
    expect(res.status).toBe(201);
    const body = await res.json<{ id: string }>();
    expect(body.id).toMatch(/^[0-9A-Z]{26}$/);
  });

  it('200 on duplicate add with the same id', async () => {
    const { conversationId, messageId, userApp } = await setup('rx-post-2');
    const post = (body: unknown) =>
      userApp.request(
        `/v1/messages/${messageId}/reactions`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        },
        env
      );
    const first = await post({ conversationId, emoji: '👍' });
    const firstBody = await first.json<{ id: string }>();
    const second = await post({ conversationId, emoji: '👍' });
    expect(second.status).toBe(200);
    const secondBody = await second.json<{ id: string }>();
    expect(secondBody.id).toBe(firstBody.id);
  });

  it('rejects empty emoji (400)', async () => {
    const { conversationId, messageId, userApp } = await setup('rx-post-3a');
    const res = await userApp.request(
      `/v1/messages/${messageId}/reactions`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ conversationId, emoji: '' }),
      },
      env
    );
    expect(res.status).toBe(400);
  });

  it('rejects emoji longer than 64 UTF-8 bytes (400)', async () => {
    const { conversationId, messageId, userApp } = await setup('rx-post-3b');
    const res = await userApp.request(
      `/v1/messages/${messageId}/reactions`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ conversationId, emoji: 'a'.repeat(65) }),
      },
      env
    );
    expect(res.status).toBe(400);
  });

  it('rejects emoji with control characters (400)', async () => {
    const { conversationId, messageId, userApp } = await setup('rx-post-3c');
    const res = await userApp.request(
      `/v1/messages/${messageId}/reactions`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ conversationId, emoji: 'ok\u0000' }),
      },
      env
    );
    expect(res.status).toBe(400);
  });

  it('403 for non-member', async () => {
    const { conversationId, messageId } = await setup('rx-post-4');
    const stranger = makeApp('user-stranger', 'user');
    const res = await stranger.request(
      `/v1/messages/${messageId}/reactions`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ conversationId, emoji: '👍' }),
      },
      env
    );
    expect(res.status).toBe(403);
  });

  it('404 when adding a reaction to a deleted message', async () => {
    const { conversationId, messageId, userApp } = await setup('rx-post-deleted');
    const del = await userApp.request(
      `/v1/messages/${messageId}?${new URLSearchParams({ conversationId }).toString()}`,
      { method: 'DELETE' },
      env
    );
    expect(del.status).toBe(204);

    const res = await userApp.request(
      `/v1/messages/${messageId}/reactions`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ conversationId, emoji: '👍' }),
      },
      env
    );
    expect(res.status).toBe(404);
  });

  it('400 for invalid message ID (not a ULID)', async () => {
    const { conversationId, userApp } = await setup('rx-post-5');
    const res = await userApp.request(
      `/v1/messages/not-a-ulid/reactions`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ conversationId, emoji: '👍' }),
      },
      env
    );
    expect(res.status).toBe(400);
  });
});

describe('DELETE /v1/messages/:id/reactions', () => {
  it('204 when removing a live reaction via query params', async () => {
    const { conversationId, messageId, userApp } = await setup('rx-del-1');
    await userApp.request(
      `/v1/messages/${messageId}/reactions`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ conversationId, emoji: '👍' }),
      },
      env
    );
    const qs = new URLSearchParams({ conversationId, emoji: '👍' });
    const res = await userApp.request(
      `/v1/messages/${messageId}/reactions?${qs.toString()}`,
      { method: 'DELETE' },
      env
    );
    expect(res.status).toBe(204);
  });

  it('204 even when reaction never existed (idempotent)', async () => {
    const { conversationId, messageId, userApp } = await setup('rx-del-2');
    const qs = new URLSearchParams({ conversationId, emoji: '👍' });
    const res = await userApp.request(
      `/v1/messages/${messageId}/reactions?${qs.toString()}`,
      { method: 'DELETE' },
      env
    );
    expect(res.status).toBe(204);
  });

  it('404 when removing a reaction from a deleted message', async () => {
    const { conversationId, messageId, userApp } = await setup('rx-del-deleted');
    const deleteMessage = await userApp.request(
      `/v1/messages/${messageId}?${new URLSearchParams({ conversationId }).toString()}`,
      { method: 'DELETE' },
      env
    );
    expect(deleteMessage.status).toBe(204);

    const qs = new URLSearchParams({ conversationId, emoji: '👍' });
    const res = await userApp.request(
      `/v1/messages/${messageId}/reactions?${qs.toString()}`,
      { method: 'DELETE' },
      env
    );
    expect(res.status).toBe(404);
  });

  it('403 for non-member on DELETE', async () => {
    const { conversationId, messageId } = await setup('rx-del-3');
    const stranger = makeApp('user-stranger', 'user');
    const qs = new URLSearchParams({ conversationId, emoji: '👍' });
    const res = await stranger.request(
      `/v1/messages/${messageId}/reactions?${qs.toString()}`,
      { method: 'DELETE' },
      env
    );
    expect(res.status).toBe(403);
  });
});
