import { describe, it, expect, vi } from 'vitest';
import { handleKiloChatCreateConversationAction } from './create-conversation-action';
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
    listConversations: vi.fn(),
    createConversation: vi.fn().mockResolvedValue({ conversationId: '01NEWCONV' }),
    ...overrides,
  } as KiloChatClient;
}

describe('handleKiloChatCreateConversationAction', () => {
  it('creates conversation with name and returns formatted result', async () => {
    const client = mockClient();

    const result = await handleKiloChatCreateConversationAction({
      params: { name: 'Project Discussion' },
      client,
    });

    expect(client.createConversation).toHaveBeenCalledWith({
      title: 'Project Discussion',
      additionalMembers: undefined,
    });
    expect(result.content[0].text).toBe('Created conversation "Project Discussion" (01NEWCONV)');
  });

  it('creates conversation without name', async () => {
    const client = mockClient();

    const result = await handleKiloChatCreateConversationAction({
      params: {},
      client,
    });

    expect(client.createConversation).toHaveBeenCalledWith({
      title: undefined,
      additionalMembers: undefined,
    });
    expect(result.content[0].text).toBe('Created conversation 01NEWCONV');
  });

  it('parses comma-separated additionalMembers IDs', async () => {
    const client = mockClient();

    await handleKiloChatCreateConversationAction({
      params: { name: 'Group', additionalMembers: 'user_1, user_2, user_3' },
      client,
    });

    expect(client.createConversation).toHaveBeenCalledWith({
      title: 'Group',
      additionalMembers: ['user_1', 'user_2', 'user_3'],
    });
  });
});
