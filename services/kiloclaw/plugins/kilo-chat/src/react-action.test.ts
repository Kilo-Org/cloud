import { describe, it, expect, vi } from 'vitest';
import { handleKiloChatReactAction, normalizeEmoji } from './react-action';
import type { KiloChatClient } from './client';

function mockClient(overrides: Partial<KiloChatClient> = {}): KiloChatClient {
  return {
    createMessage: vi.fn(),
    editMessage: vi.fn(),
    deleteMessage: vi.fn(),
    sendTyping: vi.fn(),
    sendTypingStop: vi.fn(),
    addReaction: vi.fn().mockResolvedValue({ id: 'RID' }),
    removeReaction: vi.fn().mockResolvedValue(undefined),
    listMessages: vi.fn(),
    getMembers: vi.fn(),
    renameConversation: vi.fn(),
    ...overrides,
  } as KiloChatClient;
}

describe('normalizeEmoji', () => {
  it('passes through unicode emoji unchanged', () => {
    expect(normalizeEmoji('\u{1F44D}')).toBe('\u{1F44D}');
    expect(normalizeEmoji('\u{1F468}\u200D\u{1F469}\u200D\u{1F467}\u200D\u{1F466}')).toBe(
      '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}\u200D\u{1F466}'
    );
  });

  it('expands bare shortcodes like "thumbsup" to unicode', () => {
    expect(normalizeEmoji('thumbsup')).toBe('\u{1F44D}');
  });

  it('expands :colon-wrapped: shortcodes', () => {
    expect(normalizeEmoji(':tada:')).toBe('\u{1F389}');
  });

  it('returns empty string unchanged (interpreted as remove signal by caller)', () => {
    expect(normalizeEmoji('')).toBe('');
  });

  it('returns unknown shortcode unchanged (no fallback expansion)', () => {
    expect(normalizeEmoji('zzznotarealemoji')).toBe('zzznotarealemoji');
  });
});

describe('handleKiloChatReactAction', () => {
  const baseArgs = {
    action: 'react' as const,
    cfg: {} as never,
    toolContext: { currentChannelId: 'CONV', currentMessageId: 'MID' },
  };

  it('adds a reaction with unicode emoji', async () => {
    const client = mockClient();
    const result = await handleKiloChatReactAction({
      ...baseArgs,
      params: { emoji: '\u{1F44D}' },
      client,
    });
    expect(client.addReaction).toHaveBeenCalledWith({
      conversationId: 'CONV',
      messageId: 'MID',
      emoji: '\u{1F44D}',
    });
    expect(result.details).toMatchObject({ added: true, emoji: '\u{1F44D}', id: 'RID' });
  });

  it('normalizes shortcode to unicode before calling the service', async () => {
    const client = mockClient();
    await handleKiloChatReactAction({
      ...baseArgs,
      params: { emoji: 'thumbsup' },
      client,
    });
    expect(client.addReaction).toHaveBeenCalledWith(
      expect.objectContaining({ emoji: '\u{1F44D}' })
    );
  });

  it('removes when remove: true', async () => {
    const client = mockClient();
    const result = await handleKiloChatReactAction({
      ...baseArgs,
      params: { emoji: '\u{1F44D}', remove: true },
      client,
    });
    expect(client.removeReaction).toHaveBeenCalledWith({
      conversationId: 'CONV',
      messageId: 'MID',
      emoji: '\u{1F44D}',
    });
    expect(client.addReaction).not.toHaveBeenCalled();
    expect(result.details).toMatchObject({ removed: true, emoji: '\u{1F44D}' });
  });

  it('throws "emoji is required" when emoji is missing entirely (no implicit remove)', async () => {
    const client = mockClient();
    await expect(handleKiloChatReactAction({ ...baseArgs, params: {}, client })).rejects.toThrow(
      /emoji is required/i
    );
    expect(client.removeReaction).not.toHaveBeenCalled();
    expect(client.addReaction).not.toHaveBeenCalled();
  });

  it('throws "emoji is required" when emoji is an empty string (no implicit remove)', async () => {
    const client = mockClient();
    await expect(
      handleKiloChatReactAction({ ...baseArgs, params: { emoji: '' }, client })
    ).rejects.toThrow(/emoji is required/i);
    expect(client.removeReaction).not.toHaveBeenCalled();
  });

  it('throws "emoji is required" when remove: false with empty emoji', async () => {
    const client = mockClient();
    await expect(
      handleKiloChatReactAction({
        ...baseArgs,
        params: { emoji: '', remove: false },
        client,
      })
    ).rejects.toThrow(/emoji is required/i);
  });

  it('throws when remove: true with empty emoji (no bulk clear support)', async () => {
    const client = mockClient();
    await expect(
      handleKiloChatReactAction({
        ...baseArgs,
        params: { emoji: '', remove: true },
        client,
      })
    ).rejects.toThrow(/specific/i);
  });

  it('prefers explicit params.to / params.messageId over toolContext', async () => {
    const client = mockClient();
    await handleKiloChatReactAction({
      action: 'react',
      cfg: {} as never,
      params: { emoji: '\u{1F44D}', to: 'CONV2', messageId: 'MID2' },
      toolContext: baseArgs.toolContext,
      client,
    });
    expect(client.addReaction).toHaveBeenCalledWith({
      conversationId: 'CONV2',
      messageId: 'MID2',
      emoji: '\u{1F44D}',
    });
  });

  it('falls back to toolContext when params are absent', async () => {
    const client = mockClient();
    await handleKiloChatReactAction({
      ...baseArgs,
      params: { emoji: '\u{1F44D}' },
      client,
    });
    expect(client.addReaction).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'CONV', messageId: 'MID' })
    );
  });

  it('throws when conversationId cannot be resolved', async () => {
    const client = mockClient();
    await expect(
      handleKiloChatReactAction({
        action: 'react',
        cfg: {} as never,
        params: { emoji: '\u{1F44D}' },
        toolContext: { currentMessageId: 'MID' },
        client,
      })
    ).rejects.toThrow(/conversation/i);
  });

  it('throws when messageId cannot be resolved', async () => {
    const client = mockClient();
    await expect(
      handleKiloChatReactAction({
        action: 'react',
        cfg: {} as never,
        params: { emoji: '\u{1F44D}' },
        toolContext: { currentChannelId: 'CONV' },
        client,
      })
    ).rejects.toThrow(/message/i);
  });

  it('coerces a numeric currentMessageId from toolContext', async () => {
    const client = mockClient();
    await handleKiloChatReactAction({
      action: 'react',
      cfg: {} as never,
      params: { emoji: '\u{1F44D}' },
      toolContext: {
        currentChannelId: 'CONV',
        currentMessageId: 42 as unknown as string,
      },
      client,
    });
    expect(client.addReaction).toHaveBeenCalledWith(expect.objectContaining({ messageId: '42' }));
  });

  it('accepts message_id (snake_case alias) from params', async () => {
    const client = mockClient();
    await handleKiloChatReactAction({
      action: 'react',
      cfg: {} as never,
      params: { emoji: '\u{1F44D}', to: 'CONV', message_id: 'MID_SNAKE' },
      client,
    });
    expect(client.addReaction).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: 'MID_SNAKE' })
    );
  });
});
