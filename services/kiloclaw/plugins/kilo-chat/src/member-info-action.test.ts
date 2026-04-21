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
    ...overrides,
  } as KiloChatClient;
}

describe('handleKiloChatMemberInfoAction', () => {
  it('returns formatted member list on happy path', async () => {
    const client = mockClient({
      getMembers: vi.fn().mockResolvedValue({
        members: [
          { id: 'alice', kind: 'human' },
          { id: 'bot-1', kind: 'bot' },
        ],
      }),
    });

    const result = await handleKiloChatMemberInfoAction({
      params: { to: 'CONV' },
      client,
    });

    expect(client.getMembers).toHaveBeenCalledWith({ conversationId: 'CONV' });
    expect(result.content).toHaveLength(1);
    expect(result.content[0].text).toBe('Members (2):\n- alice (human)\n- bot-1 (bot)');
  });

  it('resolves conversationId from toolContext when params.to is absent', async () => {
    const client = mockClient({
      getMembers: vi.fn().mockResolvedValue({ members: [] }),
    });

    await handleKiloChatMemberInfoAction({
      params: {},
      toolContext: { currentChannelId: 'CTX_CONV' },
      client,
    });

    expect(client.getMembers).toHaveBeenCalledWith({ conversationId: 'CTX_CONV' });
  });

  it('prefers params.to over toolContext', async () => {
    const client = mockClient({
      getMembers: vi.fn().mockResolvedValue({ members: [] }),
    });

    await handleKiloChatMemberInfoAction({
      params: { to: 'PARAM_CONV' },
      toolContext: { currentChannelId: 'CTX_CONV' },
      client,
    });

    expect(client.getMembers).toHaveBeenCalledWith({ conversationId: 'PARAM_CONV' });
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
