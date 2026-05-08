import { env } from 'cloudflare:test';
import { kiloclawConversationContext } from '@kilocode/event-service';
import {
  getKiloChatEventPayloadSchema,
  type ReactionAddedEvent,
  type ReactionRemovedEvent,
} from '@kilocode/kilo-chat';
import { describe, it, expect, vi } from 'vitest';
import { makeApp } from './helpers';

function collectReactionPushes() {
  const added: ReactionAddedEvent[] = [];
  const removed: ReactionRemovedEvent[] = [];
  const pushEvent = vi.fn(
    async (_userId: string, _context: string, event: string, payload: unknown) => {
      if (event === 'reaction.added') {
        const parsed = getKiloChatEventPayloadSchema('reaction.added').safeParse(payload);
        if (parsed.success) added.push(parsed.data);
      }
      if (event === 'reaction.removed') {
        const parsed = getKiloChatEventPayloadSchema('reaction.removed').safeParse(payload);
        if (parsed.success) removed.push(parsed.data);
      }
      return true;
    }
  );
  return { pushEvent, added, removed };
}

function envWithPushEvent(pushEvent: ReturnType<typeof vi.fn>): Env {
  return {
    ...env,
    EVENT_SERVICE: {
      fetch: env.EVENT_SERVICE.fetch.bind(env.EVENT_SERVICE),
      connect: env.EVENT_SERVICE.connect.bind(env.EVENT_SERVICE),
      pushEvent,
    },
  } satisfies Env;
}

async function setup(suffix: string, testEnv: Env = env) {
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
    testEnv
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
    testEnv
  );
  expect(msgRes.status).toBe(201);
  const { messageId } = await msgRes.json<{ messageId: string }>();

  return { userId, sandboxId, botId, conversationId, messageId, userApp };
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

  it('pushes reaction.added events with the add operation id', async () => {
    const { pushEvent, added } = collectReactionPushes();
    const testEnv = envWithPushEvent(pushEvent);
    const { userId, sandboxId, conversationId, messageId, userApp } = await setup(
      'rx-post-event',
      testEnv
    );
    pushEvent.mockClear();

    const res = await userApp.request(
      `/v1/messages/${messageId}/reactions`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ conversationId, emoji: '👍' }),
      },
      testEnv
    );

    expect(res.status).toBe(201);
    const body = await res.json<{ id: string }>();
    expect(pushEvent).toHaveBeenCalledWith(
      userId,
      kiloclawConversationContext(sandboxId, conversationId),
      'reaction.added',
      {
        messageId,
        operationId: body.id,
        memberId: userId,
        emoji: '👍',
      }
    );
    expect(added).toEqual([
      {
        messageId,
        operationId: body.id,
        memberId: userId,
        emoji: '👍',
      },
    ]);
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
    expect(del.status).toBe(200);
    await expect(del.json()).resolves.toEqual({ ok: true });

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
  it('returns the remove operation id when removing a live reaction via query params', async () => {
    const { conversationId, messageId, userApp } = await setup('rx-del-1');
    const addRes = await userApp.request(
      `/v1/messages/${messageId}/reactions`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ conversationId, emoji: '👍' }),
      },
      env
    );
    const addBody = await addRes.json<{ id: string }>();
    const qs = new URLSearchParams({ conversationId, emoji: '👍' });
    const res = await userApp.request(
      `/v1/messages/${messageId}/reactions?${qs.toString()}`,
      { method: 'DELETE' },
      env
    );
    expect(res.status).toBe(200);
    const body = await res.json<{ removed: boolean; id: string | null }>();
    expect(body.removed).toBe(true);
    expect(body.id).toMatch(/^[0-9A-Z]{26}$/);
    expect(body.id).not.toBe(addBody.id);
  });

  it('pushes reaction.removed events with the remove operation id', async () => {
    const { pushEvent, added, removed } = collectReactionPushes();
    const testEnv = envWithPushEvent(pushEvent);
    const { userId, sandboxId, conversationId, messageId, userApp } = await setup(
      'rx-del-event',
      testEnv
    );
    const addRes = await userApp.request(
      `/v1/messages/${messageId}/reactions`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ conversationId, emoji: '👍' }),
      },
      testEnv
    );
    const addBody = await addRes.json<{ id: string }>();
    added.length = 0;
    removed.length = 0;
    pushEvent.mockClear();

    const qs = new URLSearchParams({ conversationId, emoji: '👍' });
    const res = await userApp.request(
      `/v1/messages/${messageId}/reactions?${qs.toString()}`,
      { method: 'DELETE' },
      testEnv
    );

    expect(res.status).toBe(200);
    const body = await res.json<{ removed: boolean; id: string | null }>();
    expect(pushEvent).toHaveBeenCalledOnce();
    expect(pushEvent).toHaveBeenCalledWith(
      userId,
      kiloclawConversationContext(sandboxId, conversationId),
      'reaction.removed',
      expect.objectContaining({
        messageId,
        memberId: userId,
        emoji: '👍',
      })
    );
    expect(removed).toHaveLength(1);
    expect(removed[0]).toMatchObject({
      messageId,
      memberId: userId,
      emoji: '👍',
    });
    expect(removed[0]?.operationId).toMatch(/^[0-9A-Z]{26}$/);
    expect(removed[0]?.operationId).not.toBe(addBody.id);
    expect(body).toEqual({ removed: true, id: removed[0]?.operationId });
  });

  it('returns the first tombstone id for idempotent removes without a duplicate event', async () => {
    const { pushEvent, removed } = collectReactionPushes();
    const testEnv = envWithPushEvent(pushEvent);
    const { conversationId, messageId, userApp } = await setup('rx-del-idempotent', testEnv);

    const addRes = await userApp.request(
      `/v1/messages/${messageId}/reactions`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ conversationId, emoji: '👍' }),
      },
      testEnv
    );
    expect(addRes.status).toBe(201);

    const qs = new URLSearchParams({ conversationId, emoji: '👍' });
    const firstRemoveRes = await userApp.request(
      `/v1/messages/${messageId}/reactions?${qs.toString()}`,
      { method: 'DELETE' },
      testEnv
    );
    expect(firstRemoveRes.status).toBe(200);
    const firstRemoveBody = await firstRemoveRes.json<{ removed: boolean; id: string | null }>();
    expect(firstRemoveBody.removed).toBe(true);
    expect(firstRemoveBody.id).toMatch(/^[0-9A-Z]{26}$/);
    expect(removed).toHaveLength(1);

    pushEvent.mockClear();
    const secondRemoveRes = await userApp.request(
      `/v1/messages/${messageId}/reactions?${qs.toString()}`,
      { method: 'DELETE' },
      testEnv
    );

    expect(secondRemoveRes.status).toBe(200);
    await expect(secondRemoveRes.json()).resolves.toEqual({
      removed: false,
      id: firstRemoveBody.id,
    });
    expect(pushEvent).not.toHaveBeenCalled();
    expect(removed).toHaveLength(1);
  });

  it('returns an explicit no-op shape when reaction never existed', async () => {
    const { conversationId, messageId, userApp } = await setup('rx-del-2');
    const qs = new URLSearchParams({ conversationId, emoji: '👍' });
    const res = await userApp.request(
      `/v1/messages/${messageId}/reactions?${qs.toString()}`,
      { method: 'DELETE' },
      env
    );
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ removed: false, id: null });
  });

  it('404 when removing a reaction from a deleted message', async () => {
    const { conversationId, messageId, userApp } = await setup('rx-del-deleted');
    const deleteMessage = await userApp.request(
      `/v1/messages/${messageId}?${new URLSearchParams({ conversationId }).toString()}`,
      { method: 'DELETE' },
      env
    );
    expect(deleteMessage.status).toBe(200);
    await expect(deleteMessage.json()).resolves.toEqual({ ok: true });

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
