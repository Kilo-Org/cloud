import { describe, expect, it } from 'vitest';
import { type InfiniteData } from '@tanstack/react-query';
import { type Message, type MessageCreatedEvent } from '@kilocode/kilo-chat';

import { applyMessageCreatedEventToPages } from '@kilocode/kilo-chat-hooks';

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
    const data: InfiniteData<Message[], string | undefined> = {
      pages: [[message('existing')]],
      pageParams: [undefined],
    };
    const event = {
      messageId: 'bot-message',
      senderId: 'bot:sandbox-1',
      content: [{ type: 'text', text: 'hello from bot' }],
      inReplyToMessageId: null,
      clientId: null,
    } satisfies MessageCreatedEvent;

    const result = applyMessageCreatedEventToPages(data, event);

    expect(result.pages[0]?.map(m => m.id)).toEqual(['bot-message', 'existing']);
  });
});
