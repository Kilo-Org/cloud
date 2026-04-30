import { describe, expect, it } from 'vitest';
import { type InfiniteData } from '@tanstack/react-query';
import {
  type Message,
  type MessageCreatedEvent,
  type MessageListResponse,
  type MessageUpdatedEvent,
} from '@kilocode/kilo-chat';

import {
  applyMessageCreatedEventToPages,
  applyMessageUpdatedEventToPages,
  updateMessageInPages,
} from '@kilocode/kilo-chat-hooks';

function message(id: string): Message {
  return {
    id,
    senderId: 'user:1',
    content: [{ type: 'text', text: id }],
    inReplyToMessageId: null,
    updatedAt: null,
    clientUpdatedAt: null,
    version: 1,
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
      version: 1,
    } satisfies MessageCreatedEvent;

    const result = applyMessageCreatedEventToPages(data, event);

    expect(result.pages[0]?.messages.map(m => m.id)).toEqual(['bot-message', 'existing']);
  });
});

describe('applyMessageUpdatedEventToPages', () => {
  it('ignores an older message update when a newer version is already cached', () => {
    const current = {
      ...message('m1'),
      content: [{ type: 'text' as const, text: 'newer' }],
      clientUpdatedAt: 200,
      version: 3,
    };
    const data: InfiniteData<MessageListResponse, string | undefined> = {
      pages: [{ messages: [current], hasMore: false, nextCursor: null }],
      pageParams: [undefined],
    };
    const staleEvent = {
      messageId: 'm1',
      content: [{ type: 'text' as const, text: 'older' }],
      clientUpdatedAt: 100,
      version: 2,
    } satisfies MessageUpdatedEvent;

    const result = applyMessageUpdatedEventToPages(data, staleEvent);

    expect(result.pages[0]?.messages[0]?.content).toEqual([{ type: 'text', text: 'newer' }]);
    expect(result.pages[0]?.messages[0]?.version).toBe(3);
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
