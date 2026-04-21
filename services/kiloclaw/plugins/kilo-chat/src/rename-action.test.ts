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
      params: { to: 'CONV1', title: 'New Title' },
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
      params: { to: 'kilo-chat:CONV1', title: 'New Title' },
      client,
    });
    expect(client.renameConversation).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'CONV1' })
    );
  });

  it('falls back to toolContext for conversationId', async () => {
    const client = mockClient();
    await handleKiloChatRenameAction({
      params: { title: 'New Title' },
      toolContext: { currentChannelId: 'CTX_CONV' },
      client,
    });
    expect(client.renameConversation).toHaveBeenCalledWith({
      conversationId: 'CTX_CONV',
      title: 'New Title',
    });
  });

  it('throws when conversationId is missing', async () => {
    const client = mockClient();
    await expect(
      handleKiloChatRenameAction({
        params: { title: 'New Title' },
        client,
      })
    ).rejects.toThrow(/conversationId/i);
  });

  it('throws when title is missing', async () => {
    const client = mockClient();
    await expect(
      handleKiloChatRenameAction({
        params: { to: 'CONV1' },
        client,
      })
    ).rejects.toThrow(/title is required/i);
  });

  it('throws when title is empty', async () => {
    const client = mockClient();
    await expect(
      handleKiloChatRenameAction({
        params: { to: 'CONV1', title: '' },
        client,
      })
    ).rejects.toThrow(/title is required/i);
  });
});
