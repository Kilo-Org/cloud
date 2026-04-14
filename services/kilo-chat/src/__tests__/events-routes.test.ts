import { env } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { createMiddleware } from 'hono/factory';
import type { AuthContext } from '../auth';
import { registerConversationRoutes } from '../routes/conversations';
import { registerEventsRoutes } from '../routes/events';
import type { ConversationDO } from '../do/conversation-do';

function makeApp(callerId: string, callerKind: 'user' | 'bot') {
  const mockAuth = createMiddleware<{ Bindings: Env; Variables: AuthContext }>(
    async (c, next) => {
      c.set('callerId', callerId);
      c.set('callerKind', callerKind);
      await next();
    }
  );

  const app = new Hono<{ Bindings: Env; Variables: AuthContext }>();
  app.use('/v1/*', mockAuth);
  registerConversationRoutes(app);
  registerEventsRoutes(app);
  return app;
}

function getConvStub(convId: string): DurableObjectStub<ConversationDO> {
  return env.CONVERSATION_DO.get(env.CONVERSATION_DO.idFromName(convId));
}

async function createConversation(suffix: string) {
  const userId = `user-${suffix}`;
  const sandboxId = `sandbox-${suffix}`;
  const userApp = makeApp(userId, 'user');

  const res = await userApp.request(
    '/v1/conversations',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sandboxId, title: `Chat ${suffix}` }),
    },
    env
  );

  expect(res.status).toBe(201);
  const { conversationId } = await res.json<{ conversationId: string }>();
  return { conversationId, userId, userApp };
}

// Non-streaming tests (safe for isolated storage)

describe('GET /v1/conversations/:id/events - access control', () => {
  it('returns 403 for a non-member', async () => {
    const { conversationId } = await createConversation('sse-nonmember-1');
    const strangerApp = makeApp('user-stranger-sse', 'user');

    const res = await strangerApp.request(
      `/v1/conversations/${conversationId}/events`,
      {},
      env
    );

    expect(res.status).toBe(403);
    await res.text(); // drain body
  });
});

describe('ConversationDO SSE subscribe via fetch() - non-streaming', () => {
  it('returns 403 for non-member', async () => {
    const stub = getConvStub('do-sse-nonmember');
    await stub.initialize({
      id: 'do-sse-conv-nm',
      title: null,
      createdBy: 'user-1',
      createdAt: 1000,
      members: [{ id: 'user-1', kind: 'user' }],
    });

    const res = await stub.fetch('https://do/subscribe?memberId=user-stranger');
    expect(res.status).toBe(403);
    await res.text(); // drain body
  });

  it('returns 403 when memberId is missing', async () => {
    const stub = getConvStub('do-sse-nomember');
    await stub.initialize({
      id: 'do-sse-conv-nom',
      title: null,
      createdBy: 'user-1',
      createdAt: 1000,
      members: [{ id: 'user-1', kind: 'user' }],
    });

    const res = await stub.fetch('https://do/subscribe');
    expect(res.status).toBe(403);
    await res.text();
  });

  it('returns 404 for unknown paths', async () => {
    const stub = getConvStub('do-sse-unknown');
    await stub.initialize({
      id: 'do-sse-conv-unk',
      title: null,
      createdBy: 'user-1',
      createdAt: 1000,
      members: [{ id: 'user-1', kind: 'user' }],
    });

    const res = await stub.fetch('https://do/unknown-path');
    expect(res.status).toBe(404);
    await res.text();
  });

  it('broadcast does not error when no clients are connected (createMessage succeeds)', async () => {
    const stub = getConvStub('do-sse-broadcast');
    await stub.initialize({
      id: 'do-sse-conv-bc',
      title: null,
      createdBy: 'user-1',
      createdAt: 1000,
      members: [{ id: 'user-1', kind: 'user' }],
    });

    // createMessage triggers broadcast — with no SSE clients this should not throw
    const result = await stub.createMessage({
      senderId: 'user-1',
      content: [{ type: 'text', text: 'Hello' }],
    });
    expect(result.ok).toBe(true);
  });
});

// Streaming tests - must be LAST in the file
// Note: These tests open SSE streaming responses. Due to a miniflare limitation
// with SQLite WAL mode and isolated storage, these tests must appear last so
// they don't affect the isolated storage cleanup for subsequent tests.
// See: https://developers.cloudflare.com/workers/testing/vitest-integration/known-issues/#isolated-storage

describe('GET /v1/conversations/:id/events - streaming response', () => {
  it('returns 200 with text/event-stream content-type for a member', async () => {
    const { conversationId, userApp } = await createConversation('sse-member-stream');

    const res = await userApp.request(
      `/v1/conversations/${conversationId}/events`,
      {},
      env
    );

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/event-stream');
    expect(res.headers.get('cache-control')).toBe('no-cache');

    await res.body?.cancel();
  });

  it('forwards last-event-id header to the DO for replay', async () => {
    const { conversationId, userApp } = await createConversation('sse-lastid-stream');

    const res = await userApp.request(
      `/v1/conversations/${conversationId}/events`,
      {
        headers: { 'last-event-id': '01ARZ3NDEKTSV4RRFFQ69G5FAV' },
      },
      env
    );

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/event-stream');

    await res.body?.cancel();
  });
});

describe('ConversationDO SSE subscribe via fetch() - streaming', () => {
  it('returns 200 text/event-stream for a member', async () => {
    const stub = getConvStub('do-sse-stream-1');
    await stub.initialize({
      id: 'do-sse-conv-s1',
      title: null,
      createdBy: 'user-1',
      createdAt: 1000,
      members: [{ id: 'user-1', kind: 'user' }],
    });

    const res = await stub.fetch('https://do/subscribe?memberId=user-1');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/event-stream');

    await res.body?.cancel();
  });

  it('replays missed messages when last-event-id is provided', async () => {
    const stub = getConvStub('do-sse-replay');
    await stub.initialize({
      id: 'do-sse-conv-replay',
      title: null,
      createdBy: 'user-1',
      createdAt: 1000,
      members: [{ id: 'user-1', kind: 'user' }],
    });

    // Create two messages
    const r1 = await stub.createMessage({
      senderId: 'user-1',
      content: [{ type: 'text', text: 'First' }],
    });
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;

    const r2 = await stub.createMessage({
      senderId: 'user-1',
      content: [{ type: 'text', text: 'Second' }],
    });
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;

    // Subscribe with last-event-id = r1.messageId — should replay r2 only
    const req = new Request('https://do/subscribe?memberId=user-1', {
      headers: { 'last-event-id': r1.messageId },
    });
    const res = await stub.fetch(req);
    expect(res.status).toBe(200);

    // Read replay events with a timeout to avoid hanging indefinitely
    const reader = res.body!.getReader();
    let received = '';
    const decoder = new TextDecoder();

    const readLoop = async () => {
      while (true) {
        const { done, value } = await reader.read();
        if (done || value === undefined) break;
        received += decoder.decode(value);
        if (received.includes('message.created')) break;
      }
    };

    // Race against a timeout so the test doesn't hang
    await Promise.race([readLoop(), new Promise<void>(r => setTimeout(r, 1000))]);
    reader.cancel().catch(() => {});

    expect(received).toContain('message.created');
    expect(received).toContain(r2.messageId);
    expect(received).not.toContain(r1.messageId);
  });
});
