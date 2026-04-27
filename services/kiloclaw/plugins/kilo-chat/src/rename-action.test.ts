import { describe, it, expect, vi } from 'vitest';
import { handleKiloChatRenameAction } from './rename-action';
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
    getMembers: vi.fn(),
    renameConversation: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as KiloChatClient;
}

describe('handleKiloChatRenameAction', () => {
  it('renames with explicit params', async () => {
    const client = mockClient();
    const result = await handleKiloChatRenameAction({
      params: { to: 'CONV1', name: 'New Title' },
      client,
    });
    expect(client.renameConversation).toHaveBeenCalledWith({
      conversationId: 'CONV1',
      title: 'New Title',
    });
    expect(result.content[0]!.text).toMatch(/Renamed.*CONV1.*New Title/);
  });

  it('strips kilo-chat: prefix from conversationId', async () => {
    const client = mockClient();
    await handleKiloChatRenameAction({
      params: { to: 'kilo-chat:CONV1', name: 'New Title' },
      client,
    });
    expect(client.renameConversation).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'CONV1' })
    );
  });

  it('accepts groupId param', async () => {
    const client = mockClient();
    await handleKiloChatRenameAction({
      params: { groupId: 'CONV1', name: 'New Title' },
      client,
    });
    expect(client.renameConversation).toHaveBeenCalledWith({
      conversationId: 'CONV1',
      title: 'New Title',
    });
  });

  it('accepts conversationId param', async () => {
    const client = mockClient();
    await handleKiloChatRenameAction({
      params: { conversationId: 'CONV2', name: 'New Title' },
      client,
    });
    expect(client.renameConversation).toHaveBeenCalledWith({
      conversationId: 'CONV2',
      title: 'New Title',
    });
  });

  it('throws when id missing even if toolContext.currentChannelId is set', async () => {
    const client = mockClient();
    await expect(
      handleKiloChatRenameAction({
        params: { name: 'New Title' },
        toolContext: { currentChannelId: 'CTX_CONV' },
        client,
      })
    ).rejects.toThrow(/groupId is required/i);
    expect(client.renameConversation).not.toHaveBeenCalled();
  });

  it('throws when conversationId is missing', async () => {
    const client = mockClient();
    await expect(
      handleKiloChatRenameAction({
        params: { name: 'New Title' },
        client,
      })
    ).rejects.toThrow(/groupId is required/i);
  });

  it('throws when name is missing', async () => {
    const client = mockClient();
    await expect(
      handleKiloChatRenameAction({
        params: { to: 'CONV1' },
        client,
      })
    ).rejects.toThrow(/name is required/i);
  });

  it('throws when name is empty', async () => {
    const client = mockClient();
    await expect(
      handleKiloChatRenameAction({
        params: { to: 'CONV1', name: '' },
        client,
      })
    ).rejects.toThrow(/name is required/i);
  });
});
