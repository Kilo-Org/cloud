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
    expect(result).toEqual({ conversations: [], total: 0 });
  });

  it('adds a conversation and lists it', async () => {
    const stub = getStub('user-2');
    await stub.addConversation({
      conversationId: 'conv-1',
      conversationTitle: 'Test Chat',
      sandboxId: 'sandbox-1',
      joinedAt: 1000,
    });
    const result = await stub.listConversations();
    expect(result.total).toBe(1);
    expect(result.conversations).toEqual([
      {
        conversationId: 'conv-1',
        conversationTitle: 'Test Chat',
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
      conversationTitle: null,
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
      conversationTitle: null,
      sandboxId: 'sandbox-1',
      joinedAt: 1000,
    });
    await stub.addConversation({
      conversationId: 'conv-b',
      conversationTitle: null,
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
      conversationTitle: null,
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
      conversationTitle: null,
      sandboxId: 'sandbox-1',
      joinedAt: 1000,
    });
    await stub.removeConversation('conv-1');
    const result = await stub.listConversations();
    expect(result).toEqual({ conversations: [], total: 0 });
  });
});
