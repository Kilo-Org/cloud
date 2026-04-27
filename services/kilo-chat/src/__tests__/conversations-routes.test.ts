import { env } from 'cloudflare:test';
import { describe, it, expect, vi } from 'vitest';
import type { ConversationDO } from '../do/conversation-do';
import type { MembershipDO } from '../do/membership-do';
import { makeApp } from './helpers';

/** Map of userId → set of sandbox IDs they own. */
const ownershipMap = new Map<string, Set<string>>();

vi.mock('../services/sandbox-ownership', () => ({
  userOwnsSandbox: async (_env: Env, userId: string, sandboxId: string) =>
    ownershipMap.get(userId)?.has(sandboxId) ?? false,
}));

function grantSandbox(userId: string, sandboxId: string) {
  if (!ownershipMap.has(userId)) ownershipMap.set(userId, new Set());
  ownershipMap.get(userId)!.add(sandboxId);
}

function getConvStub(convId: string): DurableObjectStub<ConversationDO> {
  return env.CONVERSATION_DO.get(env.CONVERSATION_DO.idFromName(convId));
}

function getMemberStub(memberId: string): DurableObjectStub<MembershipDO> {
  return env.MEMBERSHIP_DO.get(env.MEMBERSHIP_DO.idFromName(memberId));
}

describe('POST /v1/conversations', () => {
  it('creates a conversation and returns conversationId', async () => {
    grantSandbox('user-alice', 'sandbox-123');
    const app = makeApp('user-alice', 'user');
    const res = await app.request(
      '/v1/conversations',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sandboxId: 'sandbox-123', title: 'My Chat' }),
      },
      env
    );

    expect(res.status).toBe(201);
    const body = await res.json<{ conversationId: string }>();
    expect(body.conversationId).toBeTruthy();
    expect(typeof body.conversationId).toBe('string');
    expect(body.conversationId).toHaveLength(26);
  });

  it('initializes ConversationDO and MembershipDOs on creation', async () => {
    grantSandbox('user-bob', 'sandbox-456');
    const app = makeApp('user-bob', 'user');
    const res = await app.request(
      '/v1/conversations',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sandboxId: 'sandbox-456', title: 'Bob Chat' }),
      },
      env
    );

    expect(res.status).toBe(201);
    const { conversationId } = await res.json<{ conversationId: string }>();

    // Verify ConversationDO has been initialized
    const convStub = getConvStub(conversationId);
    const info = await convStub.getInfo();
    expect(info).not.toBeNull();
    expect(info!.title).toBe('Bob Chat');
    expect(info!.createdBy).toBe('user-bob');
    expect(info!.members).toContainEqual({ id: 'user-bob', kind: 'user' });
    expect(info!.members).toContainEqual({ id: 'bot:kiloclaw:sandbox-456', kind: 'bot' });

    // Verify user MembershipDO has the conversation
    const userMembership = getMemberStub('user-bob');
    const { conversations: list } = await userMembership.listConversations();
    const found = list.find(c => c.conversationId === conversationId);
    expect(found).toBeDefined();
    expect(found!.title).toBe('Bob Chat');

    // Verify bot MembershipDO has the conversation
    const botMembership = getMemberStub('bot:kiloclaw:sandbox-456');
    const { conversations: botList } = await botMembership.listConversations();
    const botFound = botList.find(c => c.conversationId === conversationId);
    expect(botFound).toBeDefined();
  });

  it('rejects bot callers with 403', async () => {
    const app = makeApp('bot:kiloclaw:sandbox-789', 'bot');
    const res = await app.request(
      '/v1/conversations',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sandboxId: 'sandbox-789' }),
      },
      env
    );

    expect(res.status).toBe(403);
    const body = await res.json<{ error: string }>();
    expect(body.error).toContain('Only users');
  });

  it('returns 403 when user does not own the sandbox', async () => {
    grantSandbox('user-unauthorized', 'sandbox-mine');
    const app = makeApp('user-unauthorized', 'user');
    const res = await app.request(
      '/v1/conversations',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sandboxId: 'sandbox-not-mine' }),
      },
      env
    );
    expect(res.status).toBe(403);
    const body = await res.json<{ error: string }>();
    expect(body.error).toContain('do not have access');
  });

  it('returns 400 for missing sandboxId', async () => {
    const app = makeApp('user-carol', 'user');
    const res = await app.request(
      '/v1/conversations',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'No sandbox' }),
      },
      env
    );

    expect(res.status).toBe(400);
    const body = await res.json<{ error: string }>();
    expect(body.error).toBe('Invalid request');
  });

  it('returns 400 for sandboxId with invalid characters', async () => {
    const app = makeApp('user-val', 'user');

    for (const bad of ['hello world', '../traversal', 'has:colon', 'a'.repeat(65)]) {
      const res = await app.request(
        '/v1/conversations',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sandboxId: bad }),
        },
        env
      );
      expect(res.status, `sandboxId "${bad}" should be rejected`).toBe(400);
    }
  });

  it('returns 400 for invalid JSON', async () => {
    const app = makeApp('user-dave', 'user');
    const res = await app.request(
      '/v1/conversations',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: 'not-json',
      },
      env
    );

    expect(res.status).toBe(400);
    const body = await res.json<{ error: string }>();
    expect(body.error).toBe('Invalid JSON');
  });
});

describe('GET /v1/conversations', () => {
  it('lists conversations for the caller', async () => {
    // First create a couple of conversations via a user app
    grantSandbox('user-eve', 'sandbox-eve-1');
    grantSandbox('user-eve', 'sandbox-eve-2');
    const app = makeApp('user-eve', 'user');

    await app.request(
      '/v1/conversations',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sandboxId: 'sandbox-eve-1', title: 'First' }),
      },
      env
    );
    await app.request(
      '/v1/conversations',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sandboxId: 'sandbox-eve-2', title: 'Second' }),
      },
      env
    );

    const res = await app.request('/v1/conversations', {}, env);
    expect(res.status).toBe(200);
    const body = await res.json<{
      conversations: Array<{ conversationId: string; title: string | null }>;
      hasMore: boolean;
      nextCursor: string | null;
    }>();
    expect(Array.isArray(body.conversations)).toBe(true);
    expect(body.conversations.length).toBeGreaterThanOrEqual(2);
    expect(body.hasMore).toBe(false);
    expect(body.nextCursor).toBeNull();
    const titles = body.conversations.map(c => c.title);
    expect(titles).toContain('First');
    expect(titles).toContain('Second');
  });

  it('returns empty list for a new user with no conversations', async () => {
    const app = makeApp('user-new-nobody', 'user');
    const res = await app.request('/v1/conversations', {}, env);
    expect(res.status).toBe(200);
    const body = await res.json<{ conversations: unknown[] }>();
    expect(body.conversations).toEqual([]);
  });
});

describe('GET /v1/conversations/:id', () => {
  it('returns conversation info for a member', async () => {
    // Create a conversation first
    grantSandbox('user-frank', 'sandbox-frank');
    const app = makeApp('user-frank', 'user');
    const createRes = await app.request(
      '/v1/conversations',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sandboxId: 'sandbox-frank', title: 'Frank Chat' }),
      },
      env
    );
    const { conversationId } = await createRes.json<{ conversationId: string }>();

    const res = await app.request(`/v1/conversations/${conversationId}`, {}, env);
    expect(res.status).toBe(200);
    const body = await res.json<{ id: string; title: string | null; members: unknown[] }>();
    expect(body.id).toBe(conversationId);
    expect(body.title).toBe('Frank Chat');
    expect(Array.isArray(body.members)).toBe(true);
  });

  it('returns 403 for non-member', async () => {
    // Create conversation as user-grace
    grantSandbox('user-grace', 'sandbox-grace');
    const gracesApp = makeApp('user-grace', 'user');
    const createRes = await gracesApp.request(
      '/v1/conversations',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sandboxId: 'sandbox-grace', title: 'Grace Chat' }),
      },
      env
    );
    const { conversationId } = await createRes.json<{ conversationId: string }>();

    // Try to access as a different user who is not a member
    const strangerApp = makeApp('user-stranger-xyz', 'user');
    const res = await strangerApp.request(`/v1/conversations/${conversationId}`, {}, env);
    expect(res.status).toBe(403);
    const body = await res.json<{ error: string }>();
    expect(body.error).toBe('Forbidden');
  });

  it('returns 403 for unknown conversation id (no member row)', async () => {
    const app = makeApp('user-nobody', 'user');
    // Use a valid 26-char ULID-like ID that was never initialized
    const res = await app.request('/v1/conversations/01ARZ3NDEKTSV4RRFFQ69G5FAV', {}, env);
    expect(res.status).toBe(403);
  });
});

describe('PATCH /v1/conversations/:id — rename', () => {
  async function createAsUser(userId: string, sandboxId: string, title: string) {
    grantSandbox(userId, sandboxId);
    const app = makeApp(userId, 'user');
    const res = await app.request(
      '/v1/conversations',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sandboxId, title }),
      },
      env
    );
    const { conversationId } = await res.json<{ conversationId: string }>();
    return { app, conversationId };
  }

  it('renames a conversation with a valid title', async () => {
    const { app, conversationId } = await createAsUser(
      'user-rename-1',
      'sandbox-rename-1',
      'Original'
    );
    const res = await app.request(
      `/v1/conversations/${conversationId}`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'New Title' }),
      },
      env
    );
    expect(res.status).toBe(200);
    const info = await getConvStub(conversationId).getInfo();
    expect(info?.title).toBe('New Title');
  });

  it('trims surrounding whitespace before persisting', async () => {
    const { app, conversationId } = await createAsUser(
      'user-rename-2',
      'sandbox-rename-2',
      'Original'
    );
    const res = await app.request(
      `/v1/conversations/${conversationId}`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: '   Trimmed Title   ' }),
      },
      env
    );
    expect(res.status).toBe(200);
    const info = await getConvStub(conversationId).getInfo();
    expect(info?.title).toBe('Trimmed Title');
  });

  it('rejects whitespace-only titles with 400', async () => {
    const { app, conversationId } = await createAsUser(
      'user-rename-3',
      'sandbox-rename-3',
      'Original'
    );
    for (const bad of ['', '   ', '\t\n ']) {
      const res = await app.request(
        `/v1/conversations/${conversationId}`,
        {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ title: bad }),
        },
        env
      );
      expect(res.status, `title ${JSON.stringify(bad)} should be rejected`).toBe(400);
    }
    // Original title should remain unchanged
    const info = await getConvStub(conversationId).getInfo();
    expect(info?.title).toBe('Original');
  });

  it('rejects titles longer than the cap with 400', async () => {
    const { app, conversationId } = await createAsUser(
      'user-rename-4',
      'sandbox-rename-4',
      'Original'
    );
    const res = await app.request(
      `/v1/conversations/${conversationId}`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'a'.repeat(201) }),
      },
      env
    );
    expect(res.status).toBe(400);
  });
});
