import { describe, it, expect, vi } from 'vitest';
import { handleKiloChatReadAction } from './read-action';
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
    listMessages: vi.fn().mockResolvedValue({ messages: [] }),
    getMembers: vi.fn(),
    renameConversation: vi.fn(),
    ...overrides,
  } as KiloChatClient;
}

describe('handleKiloChatReadAction', () => {
  it('returns formatted messages on happy path', async () => {
    const client = mockClient({
      listMessages: vi.fn().mockResolvedValue({
        messages: [
          { id: 'MSG1', senderId: 'alice', content: [{ type: 'text', text: 'Hello' }] },
          { id: 'MSG2', senderId: 'bob', content: [{ type: 'text', text: 'World' }] },
        ],
      }),
    });

    const result = await handleKiloChatReadAction({
      params: { to: 'CONV' },
      client,
    });

    expect(client.listMessages).toHaveBeenCalledWith({
      conversationId: 'CONV',
      limit: undefined,
      before: undefined,
    });
    expect(result.content).toHaveLength(1);
    expect(result.content[0].text).toBe('[MSG1] alice: Hello\n[MSG2] bob: World');
  });

  it('returns empty message when no messages exist', async () => {
    const client = mockClient({
      listMessages: vi.fn().mockResolvedValue({ messages: [] }),
    });

    const result = await handleKiloChatReadAction({
      params: { to: 'CONV' },
      client,
    });

    expect(result.content).toHaveLength(1);
    expect(result.content[0].text).toBe('No messages in this conversation.');
  });

  it('passes limit and before params to listMessages', async () => {
    const client = mockClient({
      listMessages: vi.fn().mockResolvedValue({
        messages: [{ id: 'M1', senderId: 'alice', content: [{ type: 'text', text: 'Hi' }] }],
      }),
    });

    await handleKiloChatReadAction({
      params: { to: 'CONV', limit: 5, before: 'MSG99' },
      client,
    });

    expect(client.listMessages).toHaveBeenCalledWith({
      conversationId: 'CONV',
      limit: 5,
      before: 'MSG99',
    });
  });

  it('joins multiple content blocks', async () => {
    const client = mockClient({
      listMessages: vi.fn().mockResolvedValue({
        messages: [
          {
            id: 'MSG1',
            senderId: 'alice',
            content: [
              { type: 'text', text: 'Hello ' },
              { type: 'text', text: 'World' },
            ],
          },
        ],
      }),
    });

    const result = await handleKiloChatReadAction({
      params: { to: 'CONV' },
      client,
    });

    expect(result.content[0].text).toBe('[MSG1] alice: Hello World');
  });

  it('renders deleted messages with empty body', async () => {
    const client = mockClient({
      listMessages: vi.fn().mockResolvedValue({
        messages: [{ id: 'MSG1', senderId: 'alice', content: [], deleted: true }],
      }),
    });

    const result = await handleKiloChatReadAction({
      params: { to: 'CONV' },
      client,
    });

    expect(result.content[0].text).toBe('[MSG1] alice: ');
  });

  it('handles messages with no content field gracefully', async () => {
    const client = mockClient({
      listMessages: vi.fn().mockResolvedValue({
        messages: [{ id: 'MSG1', senderId: 'alice' }],
      }),
    });

    const result = await handleKiloChatReadAction({
      params: { to: 'CONV' },
      client,
    });

    expect(result.content[0].text).toBe('[MSG1] alice: ');
  });

  it('resolves conversationId from toolContext when params.to is absent', async () => {
    const client = mockClient({
      listMessages: vi.fn().mockResolvedValue({ messages: [] }),
    });

    await handleKiloChatReadAction({
      params: {},
      toolContext: { currentChannelId: 'CTX_CONV' },
      client,
    });

    expect(client.listMessages).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'CTX_CONV' })
    );
  });

  it('prefers params.to over toolContext', async () => {
    const client = mockClient({
      listMessages: vi.fn().mockResolvedValue({ messages: [] }),
    });

    await handleKiloChatReadAction({
      params: { to: 'PARAM_CONV' },
      toolContext: { currentChannelId: 'CTX_CONV' },
      client,
    });

    expect(client.listMessages).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'PARAM_CONV' })
    );
  });

  it('throws when conversationId cannot be resolved', async () => {
    const client = mockClient();

    await expect(
      handleKiloChatReadAction({
        params: {},
        client,
      })
    ).rejects.toThrow(/conversationId/i);
  });

  it('includes ISO timestamp when updatedAt is present', async () => {
    const client = mockClient({
      listMessages: vi.fn().mockResolvedValue({
        messages: [
          {
            id: 'MSG1',
            senderId: 'alice',
            content: [{ type: 'text', text: 'Hello' }],
            updatedAt: 1713700000000,
          },
        ],
      }),
    });

    const result = await handleKiloChatReadAction({
      params: { to: 'CONV' },
      client,
    });

    const expected = new Date(1713700000000).toISOString();
    expect(result.content[0].text).toBe(`[MSG1] alice (${expected}): Hello`);
  });

  it('omits timestamp when updatedAt is null', async () => {
    const client = mockClient({
      listMessages: vi.fn().mockResolvedValue({
        messages: [
          {
            id: 'MSG1',
            senderId: 'alice',
            content: [{ type: 'text', text: 'Hello' }],
            updatedAt: null,
          },
        ],
      }),
    });

    const result = await handleKiloChatReadAction({
      params: { to: 'CONV' },
      client,
    });

    expect(result.content[0].text).toBe('[MSG1] alice: Hello');
  });
});
