import { env } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import type { ConversationDO } from '../do/conversation-do';

function getStub(convId: string): DurableObjectStub<ConversationDO> {
  const id = env.CONVERSATION_DO.idFromName(convId);
  return env.CONVERSATION_DO.get(id);
}

const BASE_PARAMS = {
  id: 'conv-test',
  title: 'Test Chat',
  createdBy: 'user-alice',
  createdAt: 1000,
  members: [
    { id: 'user-alice', kind: 'user' as const },
    { id: 'bot-1', kind: 'bot' as const },
  ],
};

describe('ConversationDO', () => {
  it('initialize + getInfo - creates conversation and returns correct info', async () => {
    const stub = getStub('conv-init-1');
    await stub.initialize(BASE_PARAMS);
    const info = await stub.getInfo();
    expect(info).not.toBeNull();
    expect(info!.id).toBe('conv-test');
    expect(info!.title).toBe('Test Chat');
    expect(info!.createdBy).toBe('user-alice');
    expect(info!.createdAt).toBe(1000);
    expect(info!.members).toHaveLength(2);
    expect(info!.members).toContainEqual({ id: 'user-alice', kind: 'user' });
    expect(info!.members).toContainEqual({ id: 'bot-1', kind: 'bot' });
  });

  it('isMember - true for member, false for non-member', async () => {
    const stub = getStub('conv-member-1');
    await stub.initialize(BASE_PARAMS);
    expect(await stub.isMember('user-alice')).toBe(true);
    expect(await stub.isMember('user-stranger')).toBe(false);
  });

  it('createMessage - creates message, returns ULID + version 1', async () => {
    const stub = getStub('conv-create-1');
    await stub.initialize(BASE_PARAMS);
    const result = await stub.createMessage({
      senderId: 'user-alice',
      content: [{ type: 'text', text: 'Hello!' }],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.messageId).toMatch(/^[0-9A-Z]{26}$/);
      expect(result.version).toBe(1);
    }
  });

  it('createMessage - rejects non-member', async () => {
    const stub = getStub('conv-create-2');
    await stub.initialize(BASE_PARAMS);
    const result = await stub.createMessage({
      senderId: 'user-stranger',
      content: [{ type: 'text', text: 'Hello!' }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('not a member');
    }
  });

  it('listMessages - reverse chronological order', async () => {
    const stub = getStub('conv-list-1');
    await stub.initialize(BASE_PARAMS);
    const r1 = await stub.createMessage({
      senderId: 'user-alice',
      content: [{ type: 'text', text: 'First' }],
    });
    const r2 = await stub.createMessage({
      senderId: 'user-alice',
      content: [{ type: 'text', text: 'Second' }],
    });
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    if (!r1.ok || !r2.ok) return;

    const { messages } = await stub.listMessages({ limit: 10 });
    expect(messages).toHaveLength(2);
    // Descending by id - second message first
    expect(messages[0].id).toBe(r2.messageId);
    expect(messages[1].id).toBe(r1.messageId);
  });

  it('listMessages - cursor pagination with before', async () => {
    const stub = getStub('conv-list-2');
    await stub.initialize(BASE_PARAMS);
    const r1 = await stub.createMessage({
      senderId: 'user-alice',
      content: [{ type: 'text', text: 'First' }],
    });
    await stub.createMessage({
      senderId: 'user-alice',
      content: [{ type: 'text', text: 'Second' }],
    });
    const r3 = await stub.createMessage({
      senderId: 'user-alice',
      content: [{ type: 'text', text: 'Third' }],
    });
    expect(r1.ok).toBe(true);
    expect(r3.ok).toBe(true);
    if (!r1.ok || !r3.ok) return;

    // Fetch page before r3 - should get r2 and r1
    const { messages } = await stub.listMessages({ limit: 10, before: r3.messageId });
    expect(messages).toHaveLength(2);
    expect(messages[0].id).not.toBe(r3.messageId);
    // All returned ids should be lexicographically less than r3
    for (const msg of messages) {
      expect(msg.id < r3.messageId).toBe(true);
    }
    // First message should NOT be included in a page before r1
    const { messages: page2 } = await stub.listMessages({ limit: 10, before: r1.messageId });
    expect(page2).toHaveLength(0);
  });

  it('editMessage - edits and increments version', async () => {
    const stub = getStub('conv-edit-1');
    await stub.initialize(BASE_PARAMS);
    const created = await stub.createMessage({
      senderId: 'user-alice',
      content: [{ type: 'text', text: 'Original' }],
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    // Send current version (1) — server auto-increments to 2
    const result = await stub.editMessage({
      messageId: created.messageId,
      senderId: 'user-alice',
      content: [{ type: 'text', text: 'Edited' }],
      version: 1,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.conflict).toBeUndefined();
    expect(result.version).toBe(2);

    const { messages } = await stub.listMessages({ limit: 10 });
    const msg = messages.find(m => m.id === created.messageId);
    expect(msg).toBeDefined();
    expect(JSON.parse(msg!.content)).toEqual([{ type: 'text', text: 'Edited' }]);
    expect(msg!.updatedAt).not.toBeNull();
  });

  it('editMessage - returns conflict on stale version', async () => {
    const stub = getStub('conv-edit-2');
    await stub.initialize(BASE_PARAMS);
    const created = await stub.createMessage({
      senderId: 'user-alice',
      content: [{ type: 'text', text: 'Original' }],
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    // Current version is 1, sending stale version 0 should conflict
    const result = await stub.editMessage({
      messageId: created.messageId,
      senderId: 'user-alice',
      content: [{ type: 'text', text: 'Stale edit' }],
      version: 0,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.conflict).toBe(true);
    expect(result.version).toBe(1);
  });

  it('editMessage - rejects non-sender', async () => {
    const stub = getStub('conv-edit-3');
    await stub.initialize(BASE_PARAMS);
    const created = await stub.createMessage({
      senderId: 'user-alice',
      content: [{ type: 'text', text: 'Original' }],
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const result = await stub.editMessage({
      messageId: created.messageId,
      senderId: 'user-stranger',
      content: [{ type: 'text', text: 'Hacked' }],
      version: 2,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('not the owner');
    }
  });

  it('deleteMessage - soft deletes', async () => {
    const stub = getStub('conv-delete-1');
    await stub.initialize(BASE_PARAMS);
    const created = await stub.createMessage({
      senderId: 'user-alice',
      content: [{ type: 'text', text: 'Delete me' }],
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const result = await stub.deleteMessage({
      messageId: created.messageId,
      senderId: 'user-alice',
    });
    expect(result.ok).toBe(true);

    const { messages } = await stub.listMessages({ limit: 10 });
    const msg = messages.find(m => m.id === created.messageId);
    expect(msg).toBeDefined();
    expect(msg!.deleted).toBe(true);
    expect(msg!.updatedAt).not.toBeNull();
  });

  it('deleteMessage - rejects non-sender', async () => {
    const stub = getStub('conv-delete-2');
    await stub.initialize(BASE_PARAMS);
    const created = await stub.createMessage({
      senderId: 'user-alice',
      content: [{ type: 'text', text: 'Delete me' }],
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const result = await stub.deleteMessage({
      messageId: created.messageId,
      senderId: 'user-stranger',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('not the owner');
    }
  });

  it('getBotMembersExcluding - returns bots except sender', async () => {
    const stub = getStub('conv-bots-1');
    await stub.initialize({
      id: 'conv-test',
      title: null,
      createdBy: 'user-alice',
      createdAt: 1000,
      members: [
        { id: 'user-alice', kind: 'user' },
        { id: 'bot-1', kind: 'bot' },
        { id: 'bot-2', kind: 'bot' },
      ],
    });
    const bots = await stub.getBotMembersExcluding('bot-1');
    expect(bots).toHaveLength(1);
    expect(bots[0].id).toBe('bot-2');
    expect(bots[0].kind).toBe('bot');

    // Should not include users
    const botsExcludingAlice = await stub.getBotMembersExcluding('user-alice');
    expect(botsExcludingAlice).toHaveLength(2);
    expect(botsExcludingAlice.every(b => b.kind === 'bot')).toBe(true);
  });
});
