import { describe, it, expect, vi } from 'vitest';
import { handleKiloChatListConversationsAction } from './list-conversations-action';
import type { KiloChatClient } from './client';

function mockClient(overrides: Partial<KiloChatClient> = {}): KiloChatClient {
  return {
    createMessage: vi.fn(),
    editMessage: vi.fn(),
    deleteMessage: vi.fn(),
    sendTyping: vi.fn(),
    sendTypingStop: vi.fn(),
    addReaction: vi.fn(),
    removeReaction: vi.fn(),
    listMessages: vi.fn(),
    getMembers: vi.fn().mockResolvedValue({ members: [] }),
    renameConversation: vi.fn(),
    listConversations: vi.fn().mockResolvedValue({
      conversations: [],
      total: 0,
      limit: 50,
      offset: 0,
    }),
    ...overrides,
  } as KiloChatClient;
}

describe('handleKiloChatListConversationsAction', () => {
  it('formats conversations with relative timestamps', async () => {
    const now = Date.now();
    const twoHoursAgo = now - 2 * 60 * 60 * 1000;
    const client = mockClient({
      listConversations: vi.fn().mockResolvedValue({
        conversations: [
          {
            conversationId: '01ABC',
            title: 'Project Discussion',
            lastActivityAt: twoHoursAgo,
            members: [
              { id: 'u1', kind: 'user', displayName: 'Igor', avatarUrl: null },
              { id: 'b1', kind: 'bot', displayName: null, avatarUrl: null },
            ],
          },
        ],
        total: 1,
        limit: 50,
        offset: 0,
      }),
    });

    const result = await handleKiloChatListConversationsAction({
      params: {},
      client,
    });

    expect(result.content[0].text).toMatch(/Conversations \(1 total\)/);
    expect(result.content[0].text).toMatch(/"Project Discussion" \(01ABC\)/);
    expect(result.content[0].text).toMatch(/2 members/);
  });

  it('returns helpful message when no conversations', async () => {
    const client = mockClient();

    const result = await handleKiloChatListConversationsAction({
      params: {},
      client,
    });

    expect(result.content[0].text).toBe('No conversations found.');
  });

  it('forwards limit to listConversations', async () => {
    const client = mockClient();

    await handleKiloChatListConversationsAction({
      params: { limit: 10 },
      client,
    });

    expect(client.listConversations).toHaveBeenCalledWith({ limit: 10 });
  });

  it('shows "no activity" when lastActivityAt is null', async () => {
    const client = mockClient({
      listConversations: vi.fn().mockResolvedValue({
        conversations: [
          {
            conversationId: '01XYZ',
            title: null,
            lastActivityAt: null,
            members: [],
          },
        ],
        total: 1,
        limit: 50,
        offset: 0,
      }),
    });

    const result = await handleKiloChatListConversationsAction({
      params: {},
      client,
    });

    expect(result.content[0].text).toMatch(/01XYZ/);
    expect(result.content[0].text).toMatch(/no activity/);
  });
});
