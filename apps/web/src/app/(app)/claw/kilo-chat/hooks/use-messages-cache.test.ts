import type { Message, MessageCreatedEvent } from '@kilocode/kilo-chat';
import {
  applyMessageCreatedEventToPages,
  type MessageInfiniteData,
} from '@kilocode/kilo-chat-hooks';

const serverMessageId = '01K8ZB8B3H9BRWZ6KCN39AX09G';
const clientId = 'client-1';

function textContent(text: string): Message['content'] {
  return [{ type: 'text', text }];
}

function actionContent(resolved = false): Message['content'] {
  const actionBlock = {
    type: 'actions',
    groupId: 'approval-1',
    actions: [{ label: 'Allow once', style: 'primary', value: 'allow-once' }],
  } satisfies Message['content'][number];

  if (!resolved) return [actionBlock];

  return [
    {
      ...actionBlock,
      resolved: {
        value: 'allow-once',
        resolvedBy: 'user-2',
        resolvedAt: 1710000003000,
      },
    },
  ];
}

function message(overrides: Partial<Message> = {}): Message {
  return {
    id: serverMessageId,
    senderId: 'user-1',
    content: textContent('server text'),
    inReplyToMessageId: null,
    replyTo: null,
    updatedAt: null,
    clientUpdatedAt: null,
    deleted: false,
    deliveryFailed: false,
    reactions: [],
    ...overrides,
  };
}

function pagesFor(cachedMessage: Message): MessageInfiniteData<unknown> {
  return {
    pages: [{ messages: [cachedMessage], hasMore: false, nextCursor: null }],
    pageParams: [undefined],
  };
}

function createdEvent(overrides: Partial<MessageCreatedEvent> = {}): MessageCreatedEvent {
  return {
    messageId: serverMessageId,
    senderId: 'user-1',
    content: textContent('server text'),
    inReplyToMessageId: '01K8ZB8B3H9BRWZ6KCN39AX09H',
    replyTo: null,
    clientId,
    ...overrides,
  };
}

function firstMessage(result: MessageInfiniteData<unknown>): Message {
  const firstPage = result.pages[0];
  if (!firstPage) throw new Error('expected first page');
  const cachedMessage = firstPage.messages[0];
  if (!cachedMessage) throw new Error('expected first message');
  return cachedMessage;
}

describe('applyMessageCreatedEventToPages', () => {
  it('preserves a delete that arrives before a delayed create', () => {
    const cached = pagesFor(message({ deleted: true, updatedAt: 1710000001000 }));
    const result = applyMessageCreatedEventToPages(cached, createdEvent());

    expect(firstMessage(result)).toMatchObject({
      id: serverMessageId,
      senderId: 'user-1',
      content: textContent('server text'),
      inReplyToMessageId: '01K8ZB8B3H9BRWZ6KCN39AX09H',
      updatedAt: 1710000001000,
      clientUpdatedAt: null,
      deleted: true,
      deliveryFailed: false,
      reactions: [],
    });
  });

  it('preserves edited content and timestamps when an edit arrives before a delayed create', () => {
    const cached = pagesFor(
      message({
        content: textContent('edited text'),
        updatedAt: 1710000002000,
        clientUpdatedAt: 1710000001500,
      })
    );

    const result = applyMessageCreatedEventToPages(cached, createdEvent());

    expect(firstMessage(result)).toMatchObject({
      id: serverMessageId,
      senderId: 'user-1',
      content: textContent('edited text'),
      updatedAt: 1710000002000,
      clientUpdatedAt: 1710000001500,
      deleted: false,
      deliveryFailed: false,
      reactions: [],
    });
  });

  it('preserves reactions that arrive before a delayed create', () => {
    const reactions = [{ emoji: '+1', count: 1, memberIds: ['user-2'] }];
    const cached = pagesFor(message({ reactions }));

    const result = applyMessageCreatedEventToPages(cached, createdEvent());

    expect(firstMessage(result)).toMatchObject({
      id: serverMessageId,
      content: textContent('server text'),
      reactions,
    });
  });

  it('preserves delivery failure that arrives before a delayed create', () => {
    const cached = pagesFor(message({ deliveryFailed: true }));

    const result = applyMessageCreatedEventToPages(cached, createdEvent());

    expect(firstMessage(result)).toMatchObject({
      id: serverMessageId,
      content: textContent('server text'),
      deliveryFailed: true,
    });
  });

  it('preserves resolved actions that arrive before a delayed create', () => {
    const cached = pagesFor(message({ content: actionContent(true) }));

    const result = applyMessageCreatedEventToPages(
      cached,
      createdEvent({ content: actionContent(false) })
    );

    expect(firstMessage(result).content).toEqual(actionContent(true));
  });

  it('still replaces pending optimistic rows with the server create snapshot', () => {
    const pending = message({
      id: `pending-${clientId}`,
      senderId: '',
      content: textContent('draft'),
      inReplyToMessageId: null,
      deliveryFailed: true,
      reactions: [{ emoji: '+1', count: 1, memberIds: ['user-2'] }],
    });

    const result = applyMessageCreatedEventToPages(pagesFor(pending), createdEvent());

    expect(firstMessage(result)).toEqual({
      id: serverMessageId,
      senderId: 'user-1',
      content: textContent('server text'),
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
