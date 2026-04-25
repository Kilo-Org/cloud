import { env } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import type { MembershipDO } from '../do/membership-do';

function getStub(memberId: string): DurableObjectStub<MembershipDO> {
  const id = env.MEMBERSHIP_DO.idFromName(memberId);
  return env.MEMBERSHIP_DO.get(id);
}

describe('MembershipDO', () => {
  it('returns empty list initially', async () => {
    const stub = getStub('user-1');
    const result = await stub.listConversations();
    expect(result).toEqual({ conversations: [], hasMore: false });
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
    await stub.addConversation({
      conversationId: 'conv-1',
      title: null,
      sandboxId: 'sandbox-1',
      joinedAt: 1000,
    });
    await stub.updateLastActivity('conv-1', 5000);
    await stub.markRead('conv-1', 4500);
    const result = await stub.listConversations();
    expect(result.conversations[0].lastReadAt).toBe(4500);
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
    expect(result).toEqual({ conversations: [], hasMore: false });
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
