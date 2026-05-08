import { describe, it, expect, vi } from 'vitest';
import { handleKiloChatDeleteAction } from './delete-action';
import type { KiloChatClient } from './client';

function mockClient(overrides: Partial<KiloChatClient> = {}): KiloChatClient {
  return {
    createMessage: vi.fn(),
    editMessage: vi.fn(),
    deleteMessage: vi.fn().mockResolvedValue(undefined),
    sendTyping: vi.fn(),
    sendTypingStop: vi.fn(),
    addReaction: vi.fn(),
    removeReaction: vi.fn(),
    listMessages: vi.fn(),
    getMembers: vi.fn(),
    renameConversation: vi.fn(),
    ...overrides,
  } as KiloChatClient;
}

describe('handleKiloChatDeleteAction', () => {
  it('deletes a message with explicit params', async () => {
    const client = mockClient();
    const result = await handleKiloChatDeleteAction({
      params: { to: 'CONV1', messageId: 'MSG1' },
      client,
    });
    expect(client.deleteMessage).toHaveBeenCalledWith({
      conversationId: 'CONV1',
      messageId: 'MSG1',
    });
    expect(result.content[0]!.text).toMatch(/Deleted.*MSG1/);
  });

  it('strips kilo-chat: prefix from conversationId', async () => {
    const client = mockClient();
    await handleKiloChatDeleteAction({
      params: { to: 'kilo-chat:CONV1', messageId: 'MSG1' },
      client,
    });
    expect(client.deleteMessage).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'CONV1' })
    );
  });

  it('falls back to toolContext for conversationId and messageId', async () => {
    const client = mockClient();
    await handleKiloChatDeleteAction({
      params: {},
      toolContext: { currentChannelId: 'CTX_CONV', currentMessageId: 'CTX_MSG' },
      client,
    });
    expect(client.deleteMessage).toHaveBeenCalledWith({
      conversationId: 'CTX_CONV',
      messageId: 'CTX_MSG',
    });
  });

  it('throws when conversationId is missing', async () => {
    const client = mockClient();
    await expect(
      handleKiloChatDeleteAction({
        params: { messageId: 'MSG1' },
        client,
      })
    ).rejects.toThrow(/conversationId/i);
  });

  it('throws when messageId is missing', async () => {
    const client = mockClient();
    await expect(
      handleKiloChatDeleteAction({
        params: { to: 'CONV1' },
        client,
      })
    ).rejects.toThrow(/messageId/i);
  });

  it('prefers explicit params over toolContext', async () => {
    const client = mockClient();
    await handleKiloChatDeleteAction({
      params: { to: 'EXPLICIT_CONV', messageId: 'EXPLICIT_MSG' },
      toolContext: { currentChannelId: 'CTX_CONV', currentMessageId: 'CTX_MSG' },
      client,
    });
    expect(client.deleteMessage).toHaveBeenCalledWith({
      conversationId: 'EXPLICIT_CONV',
      messageId: 'EXPLICIT_MSG',
    });
  });
});
