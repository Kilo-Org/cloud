import { describe, expect, it } from 'vitest';
import { type InfiniteData } from '@tanstack/react-query';
import {
  type Message,
  type MessageCreatedEvent,
  type MessageListResponse,
} from '@kilocode/kilo-chat';

import { applyMessageCreatedEventToPages, updateMessageInPages } from '@kilocode/kilo-chat-hooks';

function message(id: string): Message {
  return {
    id,
    senderId: 'user:1',
    content: [{ type: 'text', text: id }],
    inReplyToMessageId: null,
    updatedAt: null,
    clientUpdatedAt: null,
    deleted: false,
    deliveryFailed: false,
    reactions: [],
  };
}

describe('applyMessageCreatedEventToPages', () => {
  it('adds bot-created messages to the open conversation cache', () => {
    const data: InfiniteData<MessageListResponse, string | undefined> = {
      pages: [{ messages: [message('existing')], hasMore: false, nextCursor: null }],
      pageParams: [undefined],
    };
    const event = {
      messageId: 'bot-message',
      message: { ...message('bot-message'), senderId: 'bot:sandbox-1' },
      senderId: 'bot:sandbox-1',
      content: [{ type: 'text', text: 'hello from bot' }],
      inReplyToMessageId: null,
      clientId: null,
    } satisfies MessageCreatedEvent;

    const result = applyMessageCreatedEventToPages(data, event);

    expect(result.pages[0]?.messages.map(m => m.id)).toEqual(['bot-message', 'existing']);
  });
});

describe('updateMessageInPages', () => {
  it('returns the same cache object when the target message is absent', () => {
    const data: InfiniteData<MessageListResponse, string | undefined> = {
      pages: [
        { messages: [message('m1')], hasMore: true, nextCursor: 'm1' },
        { messages: [message('m2')], hasMore: false, nextCursor: null },
      ],
      pageParams: [undefined, 'm1'],
    };

    const result = updateMessageInPages(data, 'missing', msg => ({ ...msg, deleted: true }));

    expect(result).toBe(data);
  });

  it('copies only the pages array and containing page when updating a message', () => {
    const firstPage = [message('m1')];
    const secondPage = [message('m2')];
    const firstResponse = { messages: firstPage, hasMore: true, nextCursor: 'm1' };
    const secondResponse = { messages: secondPage, hasMore: false, nextCursor: null };
    const data: InfiniteData<MessageListResponse, string | undefined> = {
      pages: [firstResponse, secondResponse],
      pageParams: [undefined, 'm1'],
    };

    const result = updateMessageInPages(data, 'm2', msg => ({ ...msg, deleted: true }));

    expect(result).not.toBe(data);
    expect(result.pages).not.toBe(data.pages);
    expect(result.pages[0]).toBe(firstResponse);
    expect(result.pages[1]).not.toBe(secondResponse);
    expect(result.pages[1]?.messages[0]?.deleted).toBe(true);
  });
});
