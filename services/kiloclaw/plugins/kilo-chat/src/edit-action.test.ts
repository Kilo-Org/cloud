import { describe, it, expect, vi } from 'vitest';
import { handleKiloChatEditAction } from './edit-action';
import type { KiloChatClient } from './client';

function mockClient(overrides: Partial<KiloChatClient> = {}): KiloChatClient {
  return {
    createMessage: vi.fn(),
    editMessage: vi.fn().mockResolvedValue({ messageId: 'MSG1' }),
    deleteMessage: vi.fn(),
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

describe('handleKiloChatEditAction', () => {
  it('edits a message with explicit params', async () => {
    const client = mockClient();
    const result = await handleKiloChatEditAction({
      params: { to: 'CONV1', messageId: 'MSG1', message: 'updated text' },
      client,
    });
    expect(client.editMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: 'CONV1',
        messageId: 'MSG1',
        content: [{ type: 'text', text: 'updated text' }],
      })
    );
    expect(result.content[0]!.text).toMatch(/Edited.*MSG1/);
  });

  it('strips kilo-chat: prefix from conversationId', async () => {
    const client = mockClient();
    await handleKiloChatEditAction({
      params: { to: 'kilo-chat:CONV1', messageId: 'MSG1', message: 'updated' },
      client,
    });
    expect(client.editMessage).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'CONV1' })
    );
  });

  it('falls back to toolContext for conversationId and messageId', async () => {
    const client = mockClient();
    await handleKiloChatEditAction({
      params: { message: 'updated' },
      toolContext: { currentChannelId: 'CTX_CONV', currentMessageId: 'CTX_MSG' },
      client,
    });
    expect(client.editMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: 'CTX_CONV',
        messageId: 'CTX_MSG',
      })
    );
  });

  it('throws when message is missing', async () => {
    const client = mockClient();
    await expect(
      handleKiloChatEditAction({
        params: { to: 'CONV1', messageId: 'MSG1' },
        client,
      })
    ).rejects.toThrow(/message is required/i);
  });

  it('throws when conversationId is missing', async () => {
    const client = mockClient();
    await expect(
      handleKiloChatEditAction({
        params: { messageId: 'MSG1', message: 'updated' },
        client,
      })
    ).rejects.toThrow(/conversationId/i);
  });

  it('throws when messageId is missing', async () => {
    const client = mockClient();
    await expect(
      handleKiloChatEditAction({
        params: { to: 'CONV1', message: 'updated' },
        client,
      })
    ).rejects.toThrow(/messageId/i);
  });

  it('reports stale edit without throwing', async () => {
    const client = mockClient({
      editMessage: vi.fn().mockResolvedValue({ messageId: 'MSG1', stale: true }),
    });
    const result = await handleKiloChatEditAction({
      params: { to: 'CONV1', messageId: 'MSG1', message: 'updated' },
      client,
    });
    expect(result.content[0]!.text).toMatch(/stale/i);
  });
});
