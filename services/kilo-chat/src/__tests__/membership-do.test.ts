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
    expect(result).toEqual([]);
  });

  it('adds a conversation and lists it', async () => {
    const stub = getStub('user-2');
    await stub.addConversation({
      conversationId: 'conv-1',
      conversationTitle: 'Test Chat',
      joinedAt: 1000,
    });
    const result = await stub.listConversations();
    expect(result).toEqual([
      {
        conversationId: 'conv-1',
        conversationTitle: 'Test Chat',
        lastMessageId: null,
        lastReadMessageId: null,
        joinedAt: 1000,
      },
    ]);
  });

  it('updates lastMessageId', async () => {
    const stub = getStub('user-3');
    await stub.addConversation({
      conversationId: 'conv-1',
      conversationTitle: null,
      joinedAt: 1000,
    });
    await stub.updateLastMessageId('conv-1', '01ABC');
    const result = await stub.listConversations();
    expect(result[0].lastMessageId).toBe('01ABC');
  });

  it('lists conversations sorted by lastMessageId descending', async () => {
    const stub = getStub('user-4');
    await stub.addConversation({ conversationId: 'conv-a', conversationTitle: null, joinedAt: 1000 });
    await stub.addConversation({ conversationId: 'conv-b', conversationTitle: null, joinedAt: 2000 });
    await stub.updateLastMessageId('conv-a', '01ZZZZZ');
    await stub.updateLastMessageId('conv-b', '01AAAAA');
    const result = await stub.listConversations();
    expect(result[0].conversationId).toBe('conv-a');
    expect(result[1].conversationId).toBe('conv-b');
  });

  it('removes a conversation', async () => {
    const stub = getStub('user-5');
    await stub.addConversation({ conversationId: 'conv-1', conversationTitle: null, joinedAt: 1000 });
    await stub.removeConversation('conv-1');
    const result = await stub.listConversations();
    expect(result).toEqual([]);
  });
});
