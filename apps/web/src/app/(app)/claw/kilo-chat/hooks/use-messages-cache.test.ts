import type { InfiniteData } from '@tanstack/react-query';
import type { Message, MessageCreatedEvent } from '@kilocode/kilo-chat';
import { applyMessageCreatedEventToPages } from '@kilocode/kilo-chat-hooks';

describe('applyMessageCreatedEventToPages', () => {
  it('replaces stale optimistic rows that already have the server message id', () => {
    const serverMessageId = '01K8ZB8B3H9BRWZ6KCN39AX09G';
    const staleAfterHttpSuccess = {
      id: serverMessageId,
      senderId: '',
      content: [{ type: 'text', text: 'draft' }],
      inReplyToMessageId: null,
      replyTo: null,
      updatedAt: null,
      clientUpdatedAt: null,
      deleted: false,
      deliveryFailed: true,
      reactions: [{ emoji: '+1', count: 1, memberIds: ['user-2'] }],
    } satisfies Message;
    const cached = {
      pages: [[staleAfterHttpSuccess]],
      pageParams: [undefined],
    } satisfies InfiniteData<Message[], unknown>;
    const event = {
      messageId: serverMessageId,
      senderId: 'user-1',
      content: [{ type: 'text', text: 'server text' }],
      inReplyToMessageId: '01K8ZB8B3H9BRWZ6KCN39AX09H',
      replyTo: null,
      clientId: 'client-1',
    } satisfies MessageCreatedEvent;

    const result = applyMessageCreatedEventToPages(cached, event);
    const firstPage = result.pages[0];
    if (!firstPage) throw new Error('expected first page');
    const firstMessage = firstPage[0];
    if (!firstMessage) throw new Error('expected first message');

    expect(firstMessage).toEqual({
      id: serverMessageId,
      senderId: 'user-1',
      content: [{ type: 'text', text: 'server text' }],
      inReplyToMessageId: '01K8ZB8B3H9BRWZ6KCN39AX09H',
      replyTo: null,
      updatedAt: null,
      clientUpdatedAt: null,
      deleted: false,
      deliveryFailed: false,
      reactions: [],
    });
  });
});
