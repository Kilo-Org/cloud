import { env, runInDurableObject } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import type { ConversationDO } from '../do/conversation-do';

function getStub(convId: string): DurableObjectStub<ConversationDO> {
  const id = env.CONVERSATION_DO.idFromName(convId);
  return env.CONVERSATION_DO.get(id);
}

async function waitForAlarm(stub: DurableObjectStub<ConversationDO>): Promise<number | null> {
  const deadline = Date.now() + 1000;
  for (;;) {
    const alarm = await runInDurableObject(stub, (_inst, state) => state.storage.getAlarm());
    if (alarm !== null) return alarm;
    if (Date.now() > deadline) return null;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
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

  it('setTyping - returns member context for an active member', async () => {
    const stub = getStub('conv-typing-active');
    await stub.initialize(BASE_PARAMS);

    await expect(stub.setTyping('user-alice')).resolves.toEqual({
      ok: true,
      memberContext: {
        humanMemberIds: ['user-alice'],
        sandboxId: null,
      },
    });
  });

  it('setTyping - rejects a non-member without member context', async () => {
    const stub = getStub('conv-typing-forbidden');
    await stub.initialize(BASE_PARAMS);

    await expect(stub.setTyping('user-stranger')).resolves.toEqual({
      ok: false,
      error: 'Not a member',
    });
  });

  it('createMessage - creates message, returns ULID and info', async () => {
    const stub = getStub('conv-create-1');
    await stub.initialize(BASE_PARAMS);
    const result = await stub.createMessage({
      senderId: 'user-alice',
      content: [{ type: 'text', text: 'Hello!' }],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.messageId).toMatch(/^[0-9A-Z]{26}$/);
      expect(result.info).not.toBeNull();
      expect(result.info.members).toHaveLength(2);
    }
  });

  it('sets an alarm when a bot message is created below the notification threshold', async () => {
    const stub = getStub('conv-bot-notification-alarm');
    await stub.initialize({
      ...BASE_PARAMS,
      id: 'conv-bot-notification-alarm',
    });

    const result = await stub.createMessage({
      senderId: 'bot-1',
      content: [{ type: 'text', text: 'short bot placeholder' }],
    });

    expect(result.ok).toBe(true);
    await expect(waitForAlarm(stub)).resolves.not.toBeNull();
  });

  it('does not create a bot notification alarm for human messages', async () => {
    const stub = getStub('conv-human-no-notification-alarm');
    await stub.initialize({
      ...BASE_PARAMS,
      id: 'conv-human-no-notification-alarm',
    });

    const result = await stub.createMessage({
      senderId: 'user-alice',
      content: [{ type: 'text', text: 'human message' }],
    });

    expect(result.ok).toBe(true);
    const alarm = await runInDurableObject(stub, (_inst, state) => state.storage.getAlarm());
    expect(alarm).toBeNull();
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

  it('createMessage - returns internal when conversation is not initialized', async () => {
    const stub = getStub('conv-create-uninitialized');

    const result = await stub.createMessage({
      senderId: 'user-alice',
      content: [{ type: 'text', text: 'Hello!' }],
    });

    expect(result).toEqual({
      ok: false,
      code: 'internal',
      error: 'Conversation not initialized',
    });
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

  it('listMessages - returns explicit hasMore and nextCursor from a sentinel row', async () => {
    const stub = getStub('conv-list-page-contract');
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

    const firstPage = await stub.listMessages({ limit: 2 });
    expect(firstPage.messages).toHaveLength(2);
    expect(firstPage.hasMore).toBe(true);
    expect(firstPage.nextCursor).toBe(firstPage.messages[1]?.id);

    const secondPage = await stub.listMessages({ limit: 2, before: firstPage.nextCursor ?? '' });
    expect(secondPage.messages.map(message => message.id)).toEqual([r1.messageId]);
    expect(secondPage.hasMore).toBe(false);
    expect(secondPage.nextCursor).toBeNull();
  });

  it('listMessages - includes a reply snapshot when parent is outside the page', async () => {
    const stub = getStub('conv-list-reply-snapshot');
    await stub.initialize(BASE_PARAMS);
    const parent = await stub.createMessage({
      senderId: 'user-alice',
      content: [{ type: 'text', text: 'Parent context' }],
    });
    expect(parent.ok).toBe(true);
    if (!parent.ok) return;

    const reply = await stub.createMessage({
      senderId: 'bot-1',
      content: [{ type: 'text', text: 'Reply body' }],
      inReplyToMessageId: parent.messageId,
    });
    expect(reply.ok).toBe(true);
    if (!reply.ok) return;

    const { messages } = await stub.listMessages({ limit: 1 });

    expect(messages).toHaveLength(1);
    expect(messages[0].id).toBe(reply.messageId);
    expect(messages[0].replyTo).toEqual({
      messageId: parent.messageId,
      senderId: 'user-alice',
      deleted: false,
      previewText: 'Parent context',
    });
  });

  it('createMessage - returns the canonical created reply message', async () => {
    const stub = getStub('conv-create-reply-message');
    await stub.initialize(BASE_PARAMS);
    const parent = await stub.createMessage({
      senderId: 'user-alice',
      content: [{ type: 'text', text: 'Parent context' }],
    });
    expect(parent.ok).toBe(true);
    if (!parent.ok) return;

    const reply = await stub.createMessage({
      senderId: 'bot-1',
      content: [{ type: 'text', text: 'Reply body' }],
      inReplyToMessageId: parent.messageId,
    });

    expect(reply.ok).toBe(true);
    if (!reply.ok) return;
    expect(reply.message).toEqual({
      id: reply.messageId,
      senderId: 'bot-1',
      content: [{ type: 'text', text: 'Reply body' }],
      inReplyToMessageId: parent.messageId,
      replyTo: {
        messageId: parent.messageId,
        senderId: 'user-alice',
        deleted: false,
        previewText: 'Parent context',
      },
      updatedAt: null,
      clientUpdatedAt: null,
      deleted: false,
      deliveryFailed: false,
      reactions: [],
    });
  });

  it('editMessage - edits message with newer timestamp', async () => {
    const stub = getStub('conv-edit-1');
    await stub.initialize(BASE_PARAMS);
    const created = await stub.createMessage({
      senderId: 'user-alice',
      content: [{ type: 'text', text: 'Original' }],
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const result = await stub.editMessage({
      messageId: created.messageId,
      senderId: 'user-alice',
      content: [{ type: 'text', text: 'Edited' }],
      clientTimestamp: Date.now(),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.stale).toBe(false);

    const { messages } = await stub.listMessages({ limit: 10 });
    const msg = messages.find(m => m.id === created.messageId);
    expect(msg).toBeDefined();
    expect(msg!.content).toEqual([{ type: 'text', text: 'Edited' }]);
    expect(msg!.clientUpdatedAt).not.toBeNull();
  });

  it('editMessage - discards stale timestamp', async () => {
    const stub = getStub('conv-edit-2');
    await stub.initialize(BASE_PARAMS);
    const created = await stub.createMessage({
      senderId: 'user-alice',
      content: [{ type: 'text', text: 'Original' }],
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    // First edit with timestamp 1000
    await stub.editMessage({
      messageId: created.messageId,
      senderId: 'user-alice',
      content: [{ type: 'text', text: 'Edit 1' }],
      clientTimestamp: 1000,
    });

    // Second edit with older timestamp should be discarded
    const result = await stub.editMessage({
      messageId: created.messageId,
      senderId: 'user-alice',
      content: [{ type: 'text', text: 'Stale edit' }],
      clientTimestamp: 500,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.stale).toBe(true);

    const { messages } = await stub.listMessages({ limit: 10 });
    const msg = messages.find(m => m.id === created.messageId);
    expect(msg!.content).toEqual([{ type: 'text', text: 'Edit 1' }]);
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
      clientTimestamp: Date.now(),
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

  it('editMessage - rejects editing a deleted message', async () => {
    const stub = getStub('conv-edit-deleted');
    await stub.initialize(BASE_PARAMS);
    const created = await stub.createMessage({
      senderId: 'user-alice',
      content: [{ type: 'text', text: 'Secret info' }],
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    await stub.deleteMessage({ messageId: created.messageId, senderId: 'user-alice' });

    // Editing a deleted message should fail
    const result = await stub.editMessage({
      messageId: created.messageId,
      senderId: 'user-alice',
      content: [{ type: 'text', text: 'Zombie edit' }],
      clientTimestamp: Date.now(),
    });
    expect(result.ok).toBe(false);
  });

  it('listMessages - scrubs content of deleted messages', async () => {
    const stub = getStub('conv-delete-scrub');
    await stub.initialize(BASE_PARAMS);
    const created = await stub.createMessage({
      senderId: 'user-alice',
      content: [{ type: 'text', text: 'Sensitive content' }],
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    await stub.deleteMessage({ messageId: created.messageId, senderId: 'user-alice' });

    const { messages } = await stub.listMessages({ limit: 10 });
    const msg = messages.find(m => m.id === created.messageId);
    expect(msg).toBeDefined();
    expect(msg!.deleted).toBe(true);
    // Content should be scrubbed — not contain original text
    expect(msg!.content).not.toContain('Sensitive content');
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

  describe('addReaction / removeReaction', () => {
    async function seed(convId: string) {
      const stub = getStub(convId);
      await stub.initialize({ ...BASE_PARAMS, id: convId });
      const created = await stub.createMessage({
        senderId: 'user-alice',
        content: [{ type: 'text', text: 'msg' }],
      });
      if (!created.ok) throw new Error('seed failed');
      return { stub, messageId: created.messageId };
    }

    it('addReaction on a fresh (message, member, emoji) returns { ok: true, added: true, id }', async () => {
      const { stub, messageId } = await seed('conv-rx-add-1');
      const r = await stub.addReaction({ messageId, memberId: 'user-alice', emoji: '👍' });
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.added).toBe(true);
        expect(r.id).toMatch(/^[0-9A-Z]{26}$/);
        if (r.added) {
          expect(r.memberContext).toEqual({
            humanMemberIds: ['user-alice'],
            sandboxId: null,
          });
        }
      }
    });

    it('addReaction is idempotent for a live tuple (returns { ok: true, added: false, id: original })', async () => {
      const { stub, messageId } = await seed('conv-rx-add-2');
      const first = await stub.addReaction({ messageId, memberId: 'user-alice', emoji: '👍' });
      const second = await stub.addReaction({ messageId, memberId: 'user-alice', emoji: '👍' });
      expect(first.ok).toBe(true);
      expect(second.ok).toBe(true);
      if (first.ok && second.ok) {
        expect(second.added).toBe(false);
        expect(second.id).toBe(first.id);
      }
    });

    it('removeReaction on a live tuple returns { ok: true, removed: true, removed_id }', async () => {
      const { stub, messageId } = await seed('conv-rx-rem-1');
      await stub.addReaction({ messageId, memberId: 'user-alice', emoji: '👍' });
      const r = await stub.removeReaction({ messageId, memberId: 'user-alice', emoji: '👍' });
      expect(r.ok).toBe(true);
      if (r.ok && r.removed) {
        expect(r.removed_id).toMatch(/^[0-9A-Z]{26}$/);
      } else {
        throw new Error('Expected removed: true');
      }
    });

    it('removeReaction is idempotent when the tuple is absent', async () => {
      const { stub, messageId } = await seed('conv-rx-rem-2');
      const r = await stub.removeReaction({ messageId, memberId: 'user-alice', emoji: '👍' });
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.removed).toBe(false);
      }
    });

    it('add -> remove -> add re-activates the same row with a new id; removed_id cleared', async () => {
      const { stub, messageId } = await seed('conv-rx-cycle');
      const a1 = await stub.addReaction({ messageId, memberId: 'user-alice', emoji: '👍' });
      await stub.removeReaction({ messageId, memberId: 'user-alice', emoji: '👍' });
      const a2 = await stub.addReaction({ messageId, memberId: 'user-alice', emoji: '👍' });
      expect(a1.ok).toBe(true);
      expect(a2.ok).toBe(true);
      if (a1.ok && a2.ok) {
        expect(a2.added).toBe(true);
        expect(a2.id).not.toBe(a1.id);
      }
    });

    it('rejects reactions on non-existent messages as not found', async () => {
      const stub = getStub('conv-rx-bad-msg');
      await stub.initialize({ ...BASE_PARAMS, id: 'conv-rx-bad-msg' });
      const result = await stub.addReaction({
        messageId: '00000000000000000000000000',
        memberId: 'user-alice',
        emoji: '👍',
      });
      expect(result).toEqual({ ok: false, code: 'not_found', error: 'Message not found' });
    });

    it('rejects reactions from non-member', async () => {
      const { stub, messageId } = await seed('conv-rx-bad-mem');
      const result = await stub.addReaction({ messageId, memberId: 'user-nonmember', emoji: '👍' });
      expect(result).toEqual({ ok: false, code: 'forbidden', error: 'Not a member' });
    });
  });

  describe('listMessages reactions aggregation', () => {
    it('returns reactions grouped by emoji with counts and member ids', async () => {
      const stub = getStub('conv-agg-1');
      await stub.initialize({
        ...BASE_PARAMS,
        id: 'conv-agg-1',
        members: [
          { id: 'user-alice', kind: 'user' },
          { id: 'user-bob', kind: 'user' },
          { id: 'bot-1', kind: 'bot' },
        ],
      });
      const m = await stub.createMessage({
        senderId: 'user-alice',
        content: [{ type: 'text', text: 'hi' }],
      });
      if (!m.ok) throw new Error('create failed');

      const a1 = await stub.addReaction({
        messageId: m.messageId,
        memberId: 'user-alice',
        emoji: '👍',
      });
      const a2 = await stub.addReaction({
        messageId: m.messageId,
        memberId: 'user-bob',
        emoji: '👍',
      });
      const a3 = await stub.addReaction({ messageId: m.messageId, memberId: 'bot-1', emoji: '🎉' });
      if (!a1.ok || !a2.ok || !a3.ok) throw new Error('add failed');

      const { messages } = await stub.listMessages({ limit: 10 });
      const msg = messages.find(x => x.id === m.messageId)!;
      expect(msg.reactions).toHaveLength(2);
      const thumbs = msg.reactions.find(r => r.emoji === '👍')!;
      expect(thumbs.count).toBe(2);
      expect(thumbs.memberIds.sort()).toEqual(['user-alice', 'user-bob']);
      const party = msg.reactions.find(r => r.emoji === '🎉')!;
      expect(party.count).toBe(1);
      expect(party.memberIds).toEqual(['bot-1']);
    });

    it('omits dead reactions from the aggregation', async () => {
      const stub = getStub('conv-agg-2');
      await stub.initialize({ ...BASE_PARAMS, id: 'conv-agg-2' });
      const m = await stub.createMessage({
        senderId: 'user-alice',
        content: [{ type: 'text', text: 'hi' }],
      });
      if (!m.ok) throw new Error('create failed');
      await stub.addReaction({ messageId: m.messageId, memberId: 'user-alice', emoji: '👍' });
      await stub.removeReaction({ messageId: m.messageId, memberId: 'user-alice', emoji: '👍' });

      const { messages } = await stub.listMessages({ limit: 10 });
      expect(messages.find(x => x.id === m.messageId)!.reactions).toEqual([]);
    });

    it('messages without any reactions still have reactions: []', async () => {
      const stub = getStub('conv-agg-3');
      await stub.initialize({ ...BASE_PARAMS, id: 'conv-agg-3' });
      const m = await stub.createMessage({
        senderId: 'user-alice',
        content: [{ type: 'text', text: 'hi' }],
      });
      if (!m.ok) throw new Error('create failed');
      const { messages } = await stub.listMessages({ limit: 10 });
      expect(messages[0].reactions).toEqual([]);
    });
  });

  it('getMessage - returns message data for existing message', async () => {
    const stub = getStub('conv-getmsg-1');
    await stub.initialize(BASE_PARAMS);
    const createResult = await stub.createMessage({
      senderId: 'user-alice',
      content: [{ type: 'text', text: 'Hello!' }],
    });
    expect(createResult.ok).toBe(true);
    if (!createResult.ok) return;

    const msg = await stub.getMessage(createResult.messageId);
    expect(msg).not.toBeNull();
    expect(msg!.id).toBe(createResult.messageId);
    expect(msg!.senderId).toBe('user-alice');
    expect(msg!.content).toEqual([{ type: 'text', text: 'Hello!' }]);
    expect(msg!.deleted).toBe(false);
  });

  it('getMessage - returns null for non-existent message', async () => {
    const stub = getStub('conv-getmsg-2');
    await stub.initialize(BASE_PARAMS);
    const msg = await stub.getMessage('NONEXISTENT00000000000000');
    expect(msg).toBeNull();
  });

  it('getMessage - returns deleted=true for soft-deleted message', async () => {
    const stub = getStub('conv-getmsg-3');
    await stub.initialize(BASE_PARAMS);
    const createResult = await stub.createMessage({
      senderId: 'user-alice',
      content: [{ type: 'text', text: 'Delete me' }],
    });
    expect(createResult.ok).toBe(true);
    if (!createResult.ok) return;

    await stub.deleteMessage({ messageId: createResult.messageId, senderId: 'user-alice' });
    const msg = await stub.getMessage(createResult.messageId);
    expect(msg).not.toBeNull();
    expect(msg!.deleted).toBe(true);
    expect(msg!.content).toEqual([]);
  });

  it('resolveMarkRead - rejects non-members and invalid markers', async () => {
    const stub = getStub('conv-resolve-read-invalid');
    await stub.initialize(BASE_PARAMS);
    const created = await stub.createMessage({
      senderId: 'user-alice',
      content: [{ type: 'text', text: 'Hello!' }],
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    await expect(stub.resolveMarkRead('user-stranger', created.messageId)).resolves.toEqual({
      ok: false,
      code: 'forbidden',
      error: 'Forbidden',
    });
    await expect(stub.resolveMarkRead('user-alice', '01KQM1HQZPNQ7RZYFGMSEZ82A8')).resolves.toEqual(
      {
        ok: false,
        code: 'invalid',
        error: 'Message does not belong to conversation',
      }
    );
  });

  it('resolveMarkRead - accepts deleted markers and returns the latest non-deleted marker', async () => {
    const stub = getStub('conv-resolve-read-deleted');
    const sandboxId = 'sandbox-resolve-read-deleted';
    await stub.initialize({
      ...BASE_PARAMS,
      members: [
        { id: 'user-alice', kind: 'user' as const },
        { id: `bot:kiloclaw:${sandboxId}`, kind: 'bot' as const },
      ],
    });
    const first = await stub.createMessage({
      senderId: 'user-alice',
      content: [{ type: 'text', text: 'First' }],
    });
    const second = await stub.createMessage({
      senderId: 'user-alice',
      content: [{ type: 'text', text: 'Second' }],
    });
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;

    await stub.deleteMessage({ messageId: second.messageId, senderId: 'user-alice' });

    await expect(stub.resolveMarkRead('user-alice', second.messageId)).resolves.toEqual({
      ok: true,
      sandboxId,
      latestNonDeletedMessageId: first.messageId,
    });
  });

  describe('executeAction', () => {
    it('returns messageSenderId so caller can target just the author bot', async () => {
      const stub = getStub('conv-execaction-sender');
      await stub.initialize({
        id: 'conv-execaction-sender',
        title: 'Action Chat',
        createdBy: 'user-alice',
        createdAt: 1000,
        members: [
          { id: 'user-alice', kind: 'user' as const },
          { id: 'bot-primary', kind: 'bot' as const },
          { id: 'bot-other', kind: 'bot' as const },
        ],
      });
      const create = await stub.createMessage({
        senderId: 'bot-primary',
        content: [
          { type: 'text' as const, text: 'approve?' },
          {
            type: 'actions' as const,
            groupId: 'g1',
            actions: [
              { value: 'allow-once', label: 'Allow', style: 'primary' as const },
              { value: 'deny', label: 'Deny', style: 'danger' as const },
            ],
          },
        ],
      });
      expect(create.ok).toBe(true);
      if (!create.ok) return;

      const result = await stub.executeAction({
        messageId: create.messageId,
        memberId: 'user-alice',
        groupId: 'g1',
        value: 'allow-once',
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.messageSenderId).toBe('bot-primary');
    });

    it('returns fanout context and active author bot target', async () => {
      const stub = getStub('conv-execaction-context');
      await stub.initialize({
        id: 'conv-execaction-context',
        title: 'Action Chat',
        createdBy: 'user-alice',
        createdAt: 1000,
        members: [
          { id: 'user-alice', kind: 'user' as const },
          { id: 'bot:kiloclaw:sandbox-action-context', kind: 'bot' as const },
          { id: 'bot:kiloclaw:sandbox-other', kind: 'bot' as const },
        ],
      });
      const create = await stub.createMessage({
        senderId: 'bot:kiloclaw:sandbox-action-context',
        content: [
          {
            type: 'actions' as const,
            groupId: 'g1',
            actions: [{ value: 'allow-once', label: 'Allow', style: 'primary' as const }],
          },
        ],
      });
      expect(create.ok).toBe(true);
      if (!create.ok) return;

      const result = await stub.executeAction({
        messageId: create.messageId,
        memberId: 'user-alice',
        groupId: 'g1',
        value: 'allow-once',
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.memberContext).toEqual({
        humanMemberIds: ['user-alice'],
        sandboxId: 'sandbox-action-context',
      });
      expect(result.targetBotId).toBe('bot:kiloclaw:sandbox-action-context');
    });

    it('does not target action webhooks when the author bot is no longer active', async () => {
      const stub = getStub('conv-execaction-left-author');
      const authorBotId = 'bot:kiloclaw:sandbox-left-author';
      await stub.initialize({
        id: 'conv-execaction-left-author',
        title: 'Action Chat',
        createdBy: 'user-alice',
        createdAt: 1000,
        members: [
          { id: 'user-alice', kind: 'user' as const },
          { id: authorBotId, kind: 'bot' as const },
          { id: 'bot:kiloclaw:sandbox-still-active', kind: 'bot' as const },
        ],
      });
      const create = await stub.createMessage({
        senderId: authorBotId,
        content: [
          {
            type: 'actions' as const,
            groupId: 'g1',
            actions: [{ value: 'deny', label: 'Deny', style: 'danger' as const }],
          },
        ],
      });
      expect(create.ok).toBe(true);
      if (!create.ok) return;
      await stub.leaveMember(authorBotId);

      const result = await stub.executeAction({
        messageId: create.messageId,
        memberId: 'user-alice',
        groupId: 'g1',
        value: 'deny',
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.memberContext).toEqual({
        humanMemberIds: ['user-alice'],
        sandboxId: 'sandbox-still-active',
      });
      expect(result.targetBotId).toBeNull();
    });

    it('stores server-owned resolution metadata for clients', async () => {
      const stub = getStub('conv-execaction-resolved-content');
      await stub.initialize({
        id: 'conv-execaction-resolved-content',
        title: 'Action Chat',
        createdBy: 'user-alice',
        createdAt: 1000,
        members: [
          { id: 'user-alice', kind: 'user' as const },
          { id: 'bot-primary', kind: 'bot' as const },
        ],
      });
      const create = await stub.createMessage({
        senderId: 'bot-primary',
        content: [
          {
            type: 'actions' as const,
            groupId: 'g1',
            actions: [
              { value: 'allow-once', label: 'Allow', style: 'primary' as const },
              { value: 'deny', label: 'Deny', style: 'danger' as const },
            ],
          },
        ],
      });
      expect(create.ok).toBe(true);
      if (!create.ok) return;

      const beforeExecute = Date.now();
      const result = await stub.executeAction({
        messageId: create.messageId,
        memberId: 'user-alice',
        groupId: 'g1',
        value: 'deny',
      });
      expect(result.ok).toBe(true);

      const after = await stub.listMessages({ limit: 10 });
      const message = after.messages.find(m => m.id === create.messageId);
      expect(message).toBeDefined();
      if (!message) return;
      const actionsBlock = message.content.find(block => block.type === 'actions');
      expect(actionsBlock).toBeDefined();
      if (!actionsBlock || actionsBlock.type !== 'actions') return;
      expect(actionsBlock.resolved?.value).toBe('deny');
      expect(actionsBlock.resolved?.resolvedBy).toBe('user-alice');
      expect(actionsBlock.resolved?.resolvedAt).toBeGreaterThanOrEqual(beforeExecute);
    });
  });

  describe('revertActionResolution', () => {
    async function setupResolved(id: string) {
      const stub = getStub(id);
      await stub.initialize({
        id,
        title: 'Action',
        createdBy: 'user-a',
        createdAt: 1000,
        members: [
          { id: 'user-a', kind: 'user' as const },
          { id: 'bot-primary', kind: 'bot' as const },
        ],
      });
      const create = await stub.createMessage({
        senderId: 'bot-primary',
        content: [
          {
            type: 'actions' as const,
            groupId: 'g1',
            actions: [{ value: 'allow-once', label: 'Allow', style: 'primary' as const }],
          },
        ],
      });
      if (!create.ok) throw new Error('setup failed');
      const exec = await stub.executeAction({
        messageId: create.messageId,
        memberId: 'user-a',
        groupId: 'g1',
        value: 'allow-once',
      });
      if (!exec.ok) throw new Error('exec failed');
      return { stub, messageId: create.messageId };
    }

    it('clears resolved and bumps version', async () => {
      const { stub, messageId } = await setupResolved('conv-revert-ok');
      const before = await stub.listMessages({ limit: 10 });
      const versionBefore =
        (before.messages[0].content.find(b => b.type === 'actions') as { resolved?: unknown })
          .resolved !== undefined;
      expect(versionBefore).toBe(true);

      const result = await stub.revertActionResolution({ messageId, groupId: 'g1' });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.reverted).toBe(true);
      }

      const after = await stub.listMessages({ limit: 10 });
      const actions = after.messages[0].content.find(b => b.type === 'actions') as {
        resolved?: unknown;
      };
      expect(actions.resolved).toBeUndefined();
    });

    it('is idempotent when already unresolved', async () => {
      const { stub, messageId } = await setupResolved('conv-revert-idem');
      const first = await stub.revertActionResolution({ messageId, groupId: 'g1' });
      expect(first.ok).toBe(true);
      if (first.ok) {
        expect(first.reverted).toBe(true);
      }
      const second = await stub.revertActionResolution({ messageId, groupId: 'g1' });
      expect(second.ok).toBe(true);
      if (second.ok) {
        expect(second.reverted).toBe(false);
      }
    });

    it('returns not_found for unknown messageId', async () => {
      const { stub } = await setupResolved('conv-revert-missing-msg');
      const result = await stub.revertActionResolution({
        messageId: '00000000000000000000000000',
        groupId: 'g1',
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('not_found');
    });

    it('returns not_found for unknown groupId', async () => {
      const { stub, messageId } = await setupResolved('conv-revert-missing-group');
      const result = await stub.revertActionResolution({ messageId, groupId: 'other' });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('not_found');
    });
  });

  describe('schema constraints', () => {
    it('rejects a reply that points at a non-existent parent message (FK)', async () => {
      const stub = getStub('conv-fk-reply');
      await stub.initialize(BASE_PARAMS);
      const result = await stub.createMessage({
        senderId: 'user-alice',
        content: [{ type: 'text', text: 'reply' }],
        inReplyToMessageId: '00000000000000000000000000',
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toMatch(/foreign key|constraint/i);
      }
    });

    it('rejects a member kind outside ("user", "bot") (CHECK)', async () => {
      const stub = getStub('conv-check-kind');
      const result = await stub.initialize({
        ...BASE_PARAMS,
        id: 'conv-check-kind',
        members: [{ id: 'x', kind: 'admin' as 'user' }],
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toMatch(/check constraint|constraint/i);
      }
    });
  });

  it('destroy - wipes all data from the conversation', async () => {
    const stub = getStub('conv-destroy-1');
    await stub.initialize({
      id: 'conv-destroy',
      title: 'Doomed Chat',
      createdBy: 'user-alice',
      createdAt: 1000,
      members: [
        { id: 'user-alice', kind: 'user' as const },
        { id: 'bot-1', kind: 'bot' as const },
      ],
    });
    await stub.createMessage({
      senderId: 'user-alice',
      content: [{ type: 'text', text: 'hello' }],
    });
    await stub.createMessage({ senderId: 'bot-1', content: [{ type: 'text', text: 'hi back' }] });

    await stub.destroyAndReturnMembers();

    const info = await stub.getInfo();
    expect(info).toBeNull();
    const messages = await stub.listMessages({ limit: 50 });
    expect(messages.messages).toHaveLength(0);
  });

  it('listMessagesIfMember - returns messages for member, null for non-member', async () => {
    const stub = getStub('conv-list-member-1');
    await stub.initialize(BASE_PARAMS);
    await stub.createMessage({
      senderId: 'user-alice',
      content: [{ type: 'text', text: 'Hello!' }],
    });

    const result = await stub.listMessagesIfMember('user-alice', { limit: 10 });
    expect(result).not.toBeNull();
    expect(result!.messages).toHaveLength(1);

    const rejected = await stub.listMessagesIfMember('user-stranger', { limit: 10 });
    expect(rejected).toBeNull();
  });

  it('destroyAndReturnMembers - is idempotent on an already-empty DO', async () => {
    const stub = getStub('conv-destroy-empty');
    await stub.destroyAndReturnMembers();
    const info = await stub.getInfo();
    expect(info).toBeNull();
  });

  it('updateTitleIfMember - updates title for member, returns members', async () => {
    const stub = getStub('conv-title-member-1');
    await stub.initialize(BASE_PARAMS);
    const result = await stub.updateTitleIfMember('user-alice', 'New Title');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.members).toHaveLength(2);
    }
    const info = await stub.getInfo();
    expect(info!.title).toBe('New Title');
  });

  it('updateTitleIfMember - rejects non-member', async () => {
    const stub = getStub('conv-title-member-2');
    await stub.initialize(BASE_PARAMS);
    const result = await stub.updateTitleIfMember('user-stranger', 'Hacked');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('forbidden');
    const info = await stub.getInfo();
    expect(info!.title).toBe('Test Chat');
  });

  it('leaveMemberIfMember - leaves and returns remaining members', async () => {
    const stub = getStub('conv-leave-member-1');
    await stub.initialize(BASE_PARAMS);
    const result = await stub.leaveMemberIfMember('user-alice');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.remainingUsers).toEqual([]);
      expect(result.botMembers).toHaveLength(1);
    }
  });

  it('leaveMemberIfMember - rejects non-member', async () => {
    const stub = getStub('conv-leave-member-2');
    await stub.initialize(BASE_PARAMS);
    const result = await stub.leaveMemberIfMember('user-stranger');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('forbidden');
  });

  it('destroyAndReturnMembers - returns members then wipes data', async () => {
    const stub = getStub('conv-destroyret-1');
    await stub.initialize(BASE_PARAMS);
    await stub.createMessage({
      senderId: 'user-alice',
      content: [{ type: 'text', text: 'hello' }],
    });
    const result = await stub.destroyAndReturnMembers();
    expect(result).not.toBeNull();
    expect(result!.members).toHaveLength(2);
    const info = await stub.getInfo();
    expect(info).toBeNull();
  });

  it('destroyAndReturnMembers - returns null for empty DO', async () => {
    const stub = getStub('conv-destroyret-2');
    const result = await stub.destroyAndReturnMembers();
    expect(result).toBeNull();
  });
});
