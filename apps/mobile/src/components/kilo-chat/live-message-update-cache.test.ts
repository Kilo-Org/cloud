import { describe, expect, it } from 'vitest';
import { type Message, type MessageUpdatedEvent } from '@kilocode/kilo-chat';

import {
  applyMessageUpdatedEventToPages,
  type MessageInfiniteData,
} from '@kilocode/kilo-chat-hooks';

function message(id: string): Message {
  return {
    id,
    senderId: 'user:1',
    content: [{ type: 'text', text: id }],
    inReplyToMessageId: null,
    replyTo: null,
    updatedAt: null,
    clientUpdatedAt: null,
    deleted: false,
    deliveryFailed: false,
    reactions: [],
  };
}

function actionMessage(
  resolved?: NonNullable<Extract<Message['content'][number], { type: 'actions' }>['resolved']>
): Message {
  return {
    ...message('action-message'),
    senderId: 'bot:sandbox-1',
    content: [
      {
        type: 'actions',
        groupId: 'approval-1',
        actions: [{ label: 'Allow once', style: 'primary', value: 'allow-once' }],
        resolved,
      },
    ],
  };
}

describe('applyMessageUpdatedEventToPages', () => {
  it('ignores delayed edit events older than the cached edit timestamp', () => {
    const newerMessage: Message = {
      ...message('01HX0000000000000000000001'),
      content: [{ type: 'text', text: 'newer content' }],
      clientUpdatedAt: 2,
    };
    const data: MessageInfiniteData = {
      pages: [{ messages: [newerMessage], hasMore: false, nextCursor: null }],
      pageParams: [undefined],
    };
    const event = {
      messageId: newerMessage.id,
      content: [{ type: 'text', text: 'older content' }],
      clientUpdatedAt: 1,
    } satisfies MessageUpdatedEvent;

    const result = applyMessageUpdatedEventToPages(data, event);

    expect(result).toBe(data);
    expect(result.pages[0]?.messages[0]).toEqual(newerMessage);
  });

  it('applies null-timestamp action resolution updates to edited cached messages', () => {
    const cachedMessage: Message = {
      ...actionMessage(),
      clientUpdatedAt: 2,
    };
    const resolvedContent = actionMessage({
      value: 'allow-once',
      resolvedBy: 'user-1',
      resolvedAt: 3,
    }).content;
    const data: MessageInfiniteData = {
      pages: [{ messages: [cachedMessage], hasMore: false, nextCursor: null }],
      pageParams: [undefined],
    };
    const event = {
      messageId: cachedMessage.id,
      content: resolvedContent,
      clientUpdatedAt: null,
    } satisfies MessageUpdatedEvent;

    const result = applyMessageUpdatedEventToPages(data, event);

    expect(result.pages[0]?.messages[0]?.content).toEqual(resolvedContent);
    expect(result.pages[0]?.messages[0]?.clientUpdatedAt).toBe(2);
  });
});
