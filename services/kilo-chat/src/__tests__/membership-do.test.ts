import { env } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import { decodeConversationCursor } from '@kilocode/kilo-chat';
import type { MembershipDO } from '../do/membership-do';

function getStub(memberId: string): DurableObjectStub<MembershipDO> {
  const id = env.MEMBERSHIP_DO.idFromName(memberId);
  return env.MEMBERSHIP_DO.get(id);
}

function decode(encoded: string) {
  const cursor = decodeConversationCursor(encoded);
  if (!cursor) throw new Error('failed to decode cursor');
  return cursor;
}

async function addConversation(stub: DurableObjectStub<MembershipDO>, conversationId: string) {
  await stub.addConversation({
    conversationId,
    title: null,
    sandboxId: 'sandbox-1',
    joinedAt: 1000,
  });
}

async function getLastReadAt(stub: DurableObjectStub<MembershipDO>, conversationId: string) {
  const { conversations } = await stub.listConversations();
  const entry = conversations.find(c => c.conversationId === conversationId);
  if (!entry) throw new Error(`missing conversation ${conversationId}`);
  return entry.lastReadAt;
}

describe('MembershipDO', () => {
  it('returns empty list initially', async () => {
    const stub = getStub('user-1');
    const result = await stub.listConversations();
    expect(result).toEqual({ conversations: [], hasMore: false, nextCursor: null });
  });

  it('adds a conversation and lists it', async () => {
    const stub = getStub('user-2');
    await stub.addConversation({
      conversationId: 'conv-1',
      title: 'Test Chat',
      sandboxId: 'sandbox-1',
      joinedAt: 1000,
    });
    const result = await stub.listConversations();
    expect(result.hasMore).toBe(false);
    expect(result.conversations).toEqual([
      {
        conversationId: 'conv-1',
        title: 'Test Chat',
        lastActivityAt: null,
        lastReadAt: null,
        joinedAt: 1000,
      },
    ]);
  });

  it('updates lastActivityAt', async () => {
    const stub = getStub('user-3');
    await stub.addConversation({
      conversationId: 'conv-1',
      title: null,
      sandboxId: 'sandbox-1',
      joinedAt: 1000,
    });
    await stub.updateLastActivity('conv-1', 5000);
    const result = await stub.listConversations();
    expect(result.conversations[0].lastActivityAt).toBe(5000);
  });

  it('lists conversations sorted by lastActivityAt descending', async () => {
    const stub = getStub('user-4');
    await stub.addConversation({
      conversationId: 'conv-a',
      title: null,
      sandboxId: 'sandbox-1',
      joinedAt: 1000,
    });
    await stub.addConversation({
      conversationId: 'conv-b',
      title: null,
      sandboxId: 'sandbox-1',
      joinedAt: 2000,
    });
    await stub.updateLastActivity('conv-a', 3000);
    await stub.updateLastActivity('conv-b', 2500);
    const result = await stub.listConversations();
    expect(result.conversations[0].conversationId).toBe('conv-a');
    expect(result.conversations[1].conversationId).toBe('conv-b');
  });

  it('marks a conversation as read', async () => {
    const stub = getStub('user-mark-read');
    await addConversation(stub, 'conv-1');
    await stub.updateLastActivity('conv-1', 5000);
    await stub.markRead('conv-1', 4500);
    const result = await stub.listConversations();
    expect(result.conversations[0].lastReadAt).toBe(4500);
  });

  describe('markReadAtLeast', () => {
    it('advances from a null read marker', async () => {
      const stub = getStub('user-mark-read-at-least-null');
      await addConversation(stub, 'conv-1');

      const result = await stub.markReadAtLeast('conv-1', 5000);

      expect(result).toEqual({ applied: true, lastReadAt: 5000 });
      expect(await getLastReadAt(stub, 'conv-1')).toBe(5000);
    });

    it('ignores an equal read marker and returns the current value', async () => {
      const stub = getStub('user-mark-read-at-least-equal');
      await addConversation(stub, 'conv-1');
      await stub.markReadAtLeast('conv-1', 5000);

      const result = await stub.markReadAtLeast('conv-1', 5000);

      expect(result).toEqual({ applied: false, lastReadAt: 5000 });
      expect(await getLastReadAt(stub, 'conv-1')).toBe(5000);
    });

    it('ignores an older read marker without lowering the stored marker', async () => {
      const stub = getStub('user-mark-read-at-least-older');
      await addConversation(stub, 'conv-1');
      await stub.markReadAtLeast('conv-1', 5000);

      const result = await stub.markReadAtLeast('conv-1', 4000);

      expect(result).toEqual({ applied: false, lastReadAt: 5000 });
      expect(await getLastReadAt(stub, 'conv-1')).toBe(5000);
    });

    it('returns not applied for a missing conversation', async () => {
      const stub = getStub('user-mark-read-at-least-missing');

      const result = await stub.markReadAtLeast('missing-conversation', 5000);

      expect(result).toEqual({ applied: false, lastReadAt: null });
    });
  });

  it('removes a conversation', async () => {
    const stub = getStub('user-5');
    await stub.addConversation({
      conversationId: 'conv-1',
      title: null,
      sandboxId: 'sandbox-1',
      joinedAt: 1000,
    });
    await stub.removeConversation('conv-1');
    const result = await stub.listConversations();
    expect(result).toEqual({ conversations: [], hasMore: false, nextCursor: null });
  });

  it('removeConversationsBySandbox - deletes only matching sandbox rows', async () => {
    const stub = getStub('user-sandbox-cleanup');
    await stub.addConversation({
      conversationId: 'conv-a',
      title: 'Chat A',
      sandboxId: 'sandbox-doomed',
      joinedAt: 1000,
    });
    await stub.addConversation({
      conversationId: 'conv-b',
      title: 'Chat B',
      sandboxId: 'sandbox-doomed',
      joinedAt: 2000,
    });
    await stub.addConversation({
      conversationId: 'conv-c',
      title: 'Chat C',
      sandboxId: 'sandbox-keep',
      joinedAt: 3000,
    });

    await stub.removeConversationsBySandbox('sandbox-doomed');

    const result = await stub.listConversations();
    expect(result.hasMore).toBe(false);
    expect(result.conversations[0].conversationId).toBe('conv-c');
  });

  it('updateLastActivityAndMarkRead - updates both fields atomically', async () => {
    const stub = getStub('user-atomic-1');
    await stub.addConversation({
      conversationId: 'conv-atomic',
      title: 'Atomic Test',
      sandboxId: 'sandbox-x',
      joinedAt: 1000,
    });

    const now = 5000;
    await stub.updateLastActivityAndMarkRead('conv-atomic', now);

    const { conversations } = await stub.listConversations();
    const entry = conversations.find(c => c.conversationId === 'conv-atomic');
    expect(entry).toBeDefined();
    expect(entry!.lastActivityAt).toBe(now);
    expect(entry!.lastReadAt).toBe(now);
  });

  describe('applyPostCommit', () => {
    it('updates only last_activity_at when markRead=false and title omitted', async () => {
      const stub = getStub('user-apc-1');
      await stub.addConversation({
        conversationId: 'conv-apc',
        title: 'Original',
        sandboxId: 'sandbox-1',
        joinedAt: 1000,
      });

      await stub.applyPostCommit({ conversationId: 'conv-apc', activityAt: 5000, markRead: false });

      const { conversations } = await stub.listConversations();
      const entry = conversations.find(c => c.conversationId === 'conv-apc');
      expect(entry).toBeDefined();
      expect(entry!.lastActivityAt).toBe(5000);
      expect(entry!.lastReadAt).toBeNull();
      expect(entry!.title).toBe('Original');
    });

    it('sets last_read_at = activityAt when markRead=true', async () => {
      const stub = getStub('user-apc-2');
      await stub.addConversation({
        conversationId: 'conv-apc',
        title: null,
        sandboxId: 'sandbox-1',
        joinedAt: 1000,
      });

      await stub.applyPostCommit({ conversationId: 'conv-apc', activityAt: 7000, markRead: true });

      const { conversations } = await stub.listConversations();
      const entry = conversations.find(c => c.conversationId === 'conv-apc');
      expect(entry!.lastActivityAt).toBe(7000);
      expect(entry!.lastReadAt).toBe(7000);
    });

    it('writes title when provided alongside activityAt and markRead', async () => {
      const stub = getStub('user-apc-3');
      await stub.addConversation({
        conversationId: 'conv-apc',
        title: null,
        sandboxId: 'sandbox-1',
        joinedAt: 1000,
      });

      await stub.applyPostCommit({
        conversationId: 'conv-apc',
        title: 'Auto-titled',
        activityAt: 9000,
        markRead: true,
      });

      const { conversations } = await stub.listConversations();
      const entry = conversations.find(c => c.conversationId === 'conv-apc');
      expect(entry!.title).toBe('Auto-titled');
      expect(entry!.lastActivityAt).toBe(9000);
      expect(entry!.lastReadAt).toBe(9000);
    });

    it('leaves title untouched when title is omitted', async () => {
      const stub = getStub('user-apc-4');
      await stub.addConversation({
        conversationId: 'conv-apc',
        title: 'Keep me',
        sandboxId: 'sandbox-1',
        joinedAt: 1000,
      });

      await stub.applyPostCommit({
        conversationId: 'conv-apc',
        activityAt: 2000,
        markRead: false,
      });

      const { conversations } = await stub.listConversations();
      const entry = conversations.find(c => c.conversationId === 'conv-apc');
      expect(entry!.title).toBe('Keep me');
    });

    it('does not lower last_activity_at when an older post-commit update arrives later', async () => {
      const stub = getStub('user-apc-activity-monotonic');
      await stub.addConversation({
        conversationId: 'conv-apc',
        title: null,
        sandboxId: 'sandbox-1',
        joinedAt: 1000,
      });

      await stub.applyPostCommit({ conversationId: 'conv-apc', activityAt: 200, markRead: false });
      await stub.applyPostCommit({ conversationId: 'conv-apc', activityAt: 100, markRead: false });

      const { conversations } = await stub.listConversations();
      expect(conversations).toContainEqual(
        expect.objectContaining({
          conversationId: 'conv-apc',
          lastActivityAt: 200,
          lastReadAt: null,
        })
      );
    });

    it('does not lower last_activity_at or last_read_at when an older read update arrives later', async () => {
      const stub = getStub('user-apc-read-monotonic');
      await stub.addConversation({
        conversationId: 'conv-apc',
        title: null,
        sandboxId: 'sandbox-1',
        joinedAt: 1000,
      });

      await stub.applyPostCommit({ conversationId: 'conv-apc', activityAt: 200, markRead: true });
      await stub.applyPostCommit({ conversationId: 'conv-apc', activityAt: 100, markRead: true });

      const { conversations } = await stub.listConversations();
      expect(conversations).toContainEqual(
        expect.objectContaining({
          conversationId: 'conv-apc',
          lastActivityAt: 200,
          lastReadAt: 200,
        })
      );
    });
  });

  describe('cursor pagination', () => {
    it('returns nextCursor when more rows are available and resumes with it', async () => {
      const stub = getStub('user-cursor-1');
      const conversationIds = [
        '01ARZ3NDEKTSV4RRFFQ69G5FA0',
        '01ARZ3NDEKTSV4RRFFQ69G5FA1',
        '01ARZ3NDEKTSV4RRFFQ69G5FA2',
        '01ARZ3NDEKTSV4RRFFQ69G5FA3',
        '01ARZ3NDEKTSV4RRFFQ69G5FA4',
      ];
      for (let i = 0; i < conversationIds.length; i++) {
        await stub.addConversation({
          conversationId: conversationIds[i],
          title: `Chat ${i}`,
          sandboxId: 'sandbox-1',
          joinedAt: 1000 + i,
        });
        await stub.updateLastActivity(conversationIds[i], 10_000 + i);
      }

      const page1 = await stub.listConversations({ limit: 2 });
      expect(page1.hasMore).toBe(true);
      expect(page1.nextCursor).toBeTruthy();
      expect(page1.conversations.map(c => c.conversationId)).toEqual([
        conversationIds[4],
        conversationIds[3],
      ]);

      const page2 = await stub.listConversations({ limit: 2, cursor: decode(page1.nextCursor!) });
      expect(page2.hasMore).toBe(true);
      expect(page2.conversations.map(c => c.conversationId)).toEqual([
        conversationIds[2],
        conversationIds[1],
      ]);

      const page3 = await stub.listConversations({ limit: 2, cursor: decode(page2.nextCursor!) });
      expect(page3.hasMore).toBe(false);
      expect(page3.nextCursor).toBeNull();
      expect(page3.conversations.map(c => c.conversationId)).toEqual([conversationIds[0]]);
    });

    it('paginates consistently when last_activity_at is null (falls back to joined_at)', async () => {
      const stub = getStub('user-cursor-2');
      const conversationIds = [
        '01BRZ3NDEKTSV4RRFFQ69G5FA0',
        '01BRZ3NDEKTSV4RRFFQ69G5FA1',
        '01BRZ3NDEKTSV4RRFFQ69G5FA2',
      ];
      for (let i = 0; i < conversationIds.length; i++) {
        await stub.addConversation({
          conversationId: conversationIds[i],
          title: null,
          sandboxId: 'sandbox-1',
          joinedAt: 1000 + i,
        });
      }

      const page1 = await stub.listConversations({ limit: 1 });
      expect(page1.conversations[0].conversationId).toBe(conversationIds[2]);
      expect(page1.hasMore).toBe(true);

      const page2 = await stub.listConversations({ limit: 1, cursor: decode(page1.nextCursor!) });
      expect(page2.conversations[0].conversationId).toBe(conversationIds[1]);

      const page3 = await stub.listConversations({ limit: 1, cursor: decode(page2.nextCursor!) });
      expect(page3.conversations[0].conversationId).toBe(conversationIds[0]);
      expect(page3.hasMore).toBe(false);
    });
  });

  it('removeConversationsBySandbox - no-op when sandbox has no conversations', async () => {
    const stub = getStub('user-sandbox-noop');
    await stub.addConversation({
      conversationId: 'conv-1',
      title: null,
      sandboxId: 'sandbox-other',
      joinedAt: 1000,
    });

    await stub.removeConversationsBySandbox('sandbox-nonexistent');

    const result = await stub.listConversations();
    expect(result.hasMore).toBe(false);
  });
});
