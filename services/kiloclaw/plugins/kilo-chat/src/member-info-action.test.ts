import { describe, it, expect, vi } from 'vitest';
import { handleKiloChatMemberInfoAction } from './member-info-action';
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
    ...overrides,
  } as KiloChatClient;
}

describe('handleKiloChatMemberInfoAction', () => {
  it('returns formatted member list with display names', async () => {
    const client = mockClient({
      getMembers: vi.fn().mockResolvedValue({
        members: [
          { id: 'alice', kind: 'user', displayName: 'Alice Smith', avatarUrl: 'https://img/a' },
          { id: 'bot-1', kind: 'bot', displayName: null, avatarUrl: null },
        ],
      }),
    });

    const result = await handleKiloChatMemberInfoAction({
      params: {},
      toolContext: { currentChannelId: 'CONV' },
      client,
    });

    expect(client.getMembers).toHaveBeenCalledWith({ conversationId: 'CONV' });
    expect(result.content).toHaveLength(1);
    expect(result.content[0].text).toBe('Members (2):\n- Alice Smith (alice, user)\n- bot-1 (bot)');
  });

  it('falls back to ID when displayName is null', async () => {
    const client = mockClient({
      getMembers: vi.fn().mockResolvedValue({
        members: [{ id: 'user-x', kind: 'user', displayName: null, avatarUrl: null }],
      }),
    });

    const result = await handleKiloChatMemberInfoAction({
      params: {},
      toolContext: { currentChannelId: 'CONV' },
      client,
    });

    expect(result.content[0].text).toBe('Members (1):\n- user-x (user)');
  });

  it('returns single-member details when target matches', async () => {
    const client = mockClient({
      getMembers: vi.fn().mockResolvedValue({
        members: [
          { id: 'alice', kind: 'user', displayName: 'Alice Smith', avatarUrl: 'https://img/a' },
          { id: 'bob', kind: 'user', displayName: 'Bob', avatarUrl: null },
        ],
      }),
    });

    const result = await handleKiloChatMemberInfoAction({
      params: { target: 'alice' },
      toolContext: { currentChannelId: 'CONV' },
      client,
    });

    expect(result.content[0].text).toContain('Member: Alice Smith');
    expect(result.content[0].text).toContain('- id: alice');
    expect(result.content[0].text).toContain('- kind: user');
    expect(result.content[0].text).toContain('- avatarUrl: https://img/a');
    expect(result.content[0].text).not.toContain('Bob');
  });

  it('accepts kilo-chat: prefix on target', async () => {
    const client = mockClient({
      getMembers: vi.fn().mockResolvedValue({
        members: [{ id: 'alice', kind: 'user', displayName: null, avatarUrl: null }],
      }),
    });

    const result = await handleKiloChatMemberInfoAction({
      params: { target: 'kilo-chat:alice' },
      toolContext: { currentChannelId: 'CONV' },
      client,
    });
    expect(result.content[0].text).toContain('- id: alice');
  });

  it('throws when target is not in the conversation', async () => {
    const client = mockClient({
      getMembers: vi.fn().mockResolvedValue({
        members: [{ id: 'alice', kind: 'user', displayName: null, avatarUrl: null }],
      }),
    });

    await expect(
      handleKiloChatMemberInfoAction({
        params: { target: 'nobody' },
        toolContext: { currentChannelId: 'CONV' },
        client,
      })
    ).rejects.toThrow(/member nobody is not in conversation CONV/);
  });

  it('throws when conversationId cannot be resolved', async () => {
    const client = mockClient();

    await expect(
      handleKiloChatMemberInfoAction({
        params: {},
        client,
      })
    ).rejects.toThrow(/conversationId/i);
  });
});
