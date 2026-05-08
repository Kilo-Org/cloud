import { describe, expect, it } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import { KiloChatApiError, type Message, type MessageListResponse } from '@kilocode/kilo-chat';
import {
  applyExecuteActionResponseToPages,
  applyCreateMessageResponseToPages,
  applyMessageCreatedEventToPages,
  applyOptimisticMessageToPages,
  createEmptyMessageInfiniteData,
  type MessageInfiniteData,
  applyReactionAddedEventToPages,
  applyReactionRemovedResponseToPages,
  applyReactionRemovedMutationToPages,
  applyOptimisticSendMessageToCache,
  createReactionOperationTracker,
  getNextMessagesPageParam,
  messagesFromListPage,
  removeMessageFromCache,
  rollbackEditMessageError,
  settleSendMessageSuccess,
  updateMessageInPages,
} from './use-messages';
import { messagesKey } from './query-keys';

function message(overrides: Partial<Message>): Message {
  return {
    id: '01KQK8A0000000000000000000',
    senderId: 'user-sender',
    content: [{ type: 'text', text: 'hello' }],
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

function messagePage(
  messages: Message[],
  overrides: Partial<MessageListResponse> = {}
): MessageListResponse {
  return {
    messages,
    hasMore: false,
    nextCursor: null,
    ...overrides,
  };
}

function firstMessage(result: MessageInfiniteData): Message | undefined {
  return result.pages[0]?.messages[0];
}

describe('reaction operation ordering', () => {
  it('keeps a successful local remove ahead of an older delayed add event', () => {
    const conversationId = '01KQK8A1111111111111111111';
    const messageId = '01KQK8A2222222222222222222';
    const currentUserId = 'user-current';
    const tracker = createReactionOperationTracker();
    const initial: MessageInfiniteData = {
      pageParams: [undefined],
      pages: [
        messagePage([
          message({
            id: messageId,
            reactions: [{ emoji: '👍', count: 1, memberIds: [currentUserId] }],
          }),
        ]),
      ],
    };

    const afterLocalRemove = applyReactionRemovedMutationToPages(initial, conversationId, tracker, {
      messageId,
      emoji: '👍',
      memberId: currentUserId,
      operationId: '01KQK8B0000000000000000000',
    });
    const afterDelayedAdd = applyReactionAddedEventToPages(
      afterLocalRemove,
      conversationId,
      tracker,
      {
        messageId,
        emoji: '👍',
        memberId: currentUserId,
        operationId: '01KQK8A9999999999999999999',
      }
    );

    expect(afterDelayedAdd.pages[0]?.messages[0]?.reactions).toEqual([]);
  });

  it('keeps a no-op remove tombstone ahead of an older delayed add event', () => {
    const conversationId = '01KQK8C1111111111111111111';
    const messageId = '01KQK8C2222222222222222222';
    const currentUserId = 'user-current';
    const tracker = createReactionOperationTracker();
    const initial: MessageInfiniteData = {
      pageParams: [undefined],
      pages: [
        messagePage([
          message({
            id: messageId,
            reactions: [{ emoji: '👍', count: 1, memberIds: [currentUserId] }],
          }),
        ]),
      ],
    };

    const afterNoOpRemove = applyReactionRemovedResponseToPages(initial, conversationId, tracker, {
      messageId,
      emoji: '👍',
      memberId: currentUserId,
      response: { removed: false, id: '01KQK8D0000000000000000000' },
    });
    const afterDelayedAdd = applyReactionAddedEventToPages(
      afterNoOpRemove,
      conversationId,
      tracker,
      {
        messageId,
        emoji: '👍',
        memberId: currentUserId,
        operationId: '01KQK8C9999999999999999999',
      }
    );

    expect(afterDelayedAdd.pages[0]?.messages[0]?.reactions).toEqual([]);
  });
});

describe('applyMessageCreatedEventToPages', () => {
  it('preserves a delete that arrives before a delayed create', () => {
    const messageId = '01KQK8S2222222222222222222';
    const cached: MessageInfiniteData = {
      pageParams: [undefined],
      pages: [messagePage([message({ id: messageId, deleted: true, updatedAt: 1710000001000 })])],
    };

    const result = applyMessageCreatedEventToPages(cached, {
      messageId,
      senderId: 'user-sender',
      content: textContent('server text'),
      inReplyToMessageId: '01KQK8S1111111111111111111',
      replyTo: null,
      clientId: 'client-1',
    });

    expect(firstMessage(result)).toMatchObject({
      id: '01KQK8S2222222222222222222',
      senderId: 'user-sender',
      content: textContent('server text'),
      inReplyToMessageId: '01KQK8S1111111111111111111',
      updatedAt: 1710000001000,
      clientUpdatedAt: null,
      deleted: true,
      deliveryFailed: false,
      reactions: [],
    });
  });

  it('preserves edited content and timestamps when an edit arrives before a delayed create', () => {
    const messageId = '01KQK8T2222222222222222222';
    const cached: MessageInfiniteData = {
      pageParams: [undefined],
      pages: [
        messagePage([
          message({
            id: messageId,
            content: textContent('edited text'),
            updatedAt: 1710000002000,
            clientUpdatedAt: 1710000001500,
          }),
        ]),
      ],
    };

    const result = applyMessageCreatedEventToPages(cached, {
      messageId,
      senderId: 'user-sender',
      content: textContent('server text'),
      inReplyToMessageId: null,
      replyTo: null,
      clientId: 'client-1',
    });

    expect(firstMessage(result)).toMatchObject({
      id: '01KQK8T2222222222222222222',
      senderId: 'user-sender',
      content: textContent('edited text'),
      updatedAt: 1710000002000,
      clientUpdatedAt: 1710000001500,
      deleted: false,
      deliveryFailed: false,
      reactions: [],
    });
  });

  it('preserves reactions that arrive before a delayed create', () => {
    const messageId = '01KQK8U2222222222222222222';
    const reactions = [{ emoji: '+1', count: 1, memberIds: ['user-2'] }];
    const cached: MessageInfiniteData = {
      pageParams: [undefined],
      pages: [messagePage([message({ id: messageId, reactions })])],
    };

    const result = applyMessageCreatedEventToPages(cached, {
      messageId,
      senderId: 'user-sender',
      content: textContent('server text'),
      inReplyToMessageId: null,
      replyTo: null,
      clientId: 'client-1',
    });

    expect(firstMessage(result)).toMatchObject({
      id: '01KQK8U2222222222222222222',
      content: textContent('server text'),
      reactions,
    });
  });

  it('preserves delivery failure that arrives before a delayed create', () => {
    const messageId = '01KQK8V2222222222222222222';
    const cached: MessageInfiniteData = {
      pageParams: [undefined],
      pages: [messagePage([message({ id: messageId, deliveryFailed: true })])],
    };

    const result = applyMessageCreatedEventToPages(cached, {
      messageId,
      senderId: 'user-sender',
      content: textContent('server text'),
      inReplyToMessageId: null,
      replyTo: null,
      clientId: 'client-1',
    });

    expect(firstMessage(result)).toMatchObject({
      id: '01KQK8V2222222222222222222',
      content: textContent('server text'),
      deliveryFailed: true,
    });
  });

  it('preserves resolved actions that arrive before a delayed create', () => {
    const messageId = '01KQK8W2222222222222222222';
    const cached: MessageInfiniteData = {
      pageParams: [undefined],
      pages: [
        messagePage([
          message({
            id: messageId,
            content: actionContent(true),
          }),
        ]),
      ],
    };

    const result = applyMessageCreatedEventToPages(cached, {
      messageId,
      senderId: 'user-sender',
      content: actionContent(false),
      inReplyToMessageId: null,
      replyTo: null,
      clientId: 'client-1',
    });

    expect(firstMessage(result)?.content).toEqual(actionContent(true));
  });

  it('still replaces pending optimistic rows with the server create snapshot', () => {
    const pendingId = 'pending-client-1';
    const result = applyMessageCreatedEventToPages(
      {
        pageParams: [undefined],
        pages: [
          messagePage([
            message({
              id: pendingId,
              senderId: '',
              content: textContent('draft'),
              inReplyToMessageId: null,
              deliveryFailed: true,
              reactions: [{ emoji: '+1', count: 1, memberIds: ['user-2'] }],
            }),
          ]),
        ],
      },
      {
        messageId: '01KQK8X2222222222222222222',
        senderId: 'user-1',
        content: textContent('server text'),
        inReplyToMessageId: '01KQK8X1111111111111111111',
        replyTo: null,
        clientId: 'client-1',
      }
    );

    expect(firstMessage(result)).toEqual({
      id: '01KQK8X2222222222222222222',
      senderId: 'user-1',
      content: textContent('server text'),
      inReplyToMessageId: '01KQK8X1111111111111111111',
      replyTo: null,
      updatedAt: null,
      clientUpdatedAt: null,
      deleted: false,
      deliveryFailed: false,
      reactions: [],
    });
  });
});

describe('edit rollback errors', () => {
  it('restores the optimistic edit and invalidates messages on edit conflict', () => {
    const queryClient = new QueryClient();
    const queryKey = messagesKey('01KQK8E1111111111111111111');
    const original = message({
      id: '01KQK8E2222222222222222222',
      content: [{ type: 'text', text: 'old local content' }],
      clientUpdatedAt: 1,
    });
    const optimistic = message({
      ...original,
      content: [{ type: 'text', text: 'losing edit' }],
      clientUpdatedAt: 2,
    });
    queryClient.setQueryData<MessageInfiniteData>(queryKey, {
      pageParams: [undefined],
      pages: [messagePage([optimistic])],
    });

    rollbackEditMessageError(
      queryClient,
      queryKey,
      original,
      optimistic,
      new KiloChatApiError(409, {
        error: 'edit_conflict',
        messageId: original.id,
      })
    );

    const result = queryClient.getQueryData<MessageInfiniteData>(queryKey);
    const query = queryClient.getQueryCache().find({ queryKey });
    expect(result?.pages[0]?.messages[0]).toEqual(original);
    expect(query?.state.isInvalidated).toBe(true);
  });
});

describe('message pagination helpers', () => {
  function fullPage(prefix: string): Message[] {
    return Array.from({ length: 50 }, (_, index) =>
      message({ id: `${prefix}-${String(index).padStart(2, '0')}` })
    );
  }

  it('uses the server-provided next cursor when present', () => {
    const messages = [
      message({ id: '01KQK8F2222222222222222222' }),
      message({ id: '01KQK8F1111111111111111111' }),
    ];
    const page = messagesFromListPage({
      messages,
      hasMore: true,
      nextCursor: '01KQK8F1111111111111111111',
    });

    expect(getNextMessagesPageParam(page)).toBe('01KQK8F1111111111111111111');
  });

  it('stops when the server says there are no more messages', () => {
    const page = messagesFromListPage({
      messages: [message({ id: '01KQK8G1111111111111111111' })],
      hasMore: false,
      nextCursor: null,
    });

    expect(getNextMessagesPageParam(page)).toBeUndefined();
  });

  it('preserves terminal-page metadata when replacing cached messages', () => {
    const page = messagesFromListPage({
      messages: fullPage('01KQK8P'),
      hasMore: false,
      nextCursor: null,
    });
    const initial: MessageInfiniteData = {
      pageParams: [undefined],
      pages: [page],
    };

    const updated = updateMessageInPages(initial, page.messages[0]?.id ?? '', msg => ({
      ...msg,
      content: [{ type: 'text', text: 'updated' }],
    }));
    const replaced = applyCreateMessageResponseToPages(updated, page.messages[1]?.id ?? '', {
      messageId: '01KQK8P-server',
      clientId: '01KQK8P-client',
      message: message({ id: '01KQK8P-server' }),
    });

    expect(getNextMessagesPageParam(updated.pages[0] ?? messagePage([]))).toBeUndefined();
    expect(getNextMessagesPageParam(replaced.pages[0] ?? messagePage([]))).toBeUndefined();
  });

  it('preserves server next cursors when replacing or extending the newest page', () => {
    const page = messagesFromListPage({
      messages: fullPage('01KQK8Q'),
      hasMore: true,
      nextCursor: 'server-cursor-after-01KQK8Q',
    });
    const initial: MessageInfiniteData = {
      pageParams: [undefined],
      pages: [page],
    };

    const afterEventMerge = applyMessageCreatedEventToPages(initial, {
      messageId: page.messages[0]?.id ?? '',
      senderId: 'user-sender',
      content: [{ type: 'text', text: 'merged' }],
      inReplyToMessageId: null,
      replyTo: null,
      clientId: null,
    });
    const afterNewMessage = applyMessageCreatedEventToPages(afterEventMerge, {
      messageId: '01KQK8Q-newer',
      senderId: 'user-sender',
      content: [{ type: 'text', text: 'newest' }],
      inReplyToMessageId: null,
      replyTo: null,
      clientId: null,
    });

    expect(getNextMessagesPageParam(afterEventMerge.pages[0] ?? messagePage([]))).toBe(
      'server-cursor-after-01KQK8Q'
    );
    expect(getNextMessagesPageParam(afterNewMessage.pages[0] ?? messagePage([]))).toBe(
      'server-cursor-after-01KQK8Q'
    );
  });

  it('preserves page metadata when removing a cached message', () => {
    const queryClient = new QueryClient();
    const queryKey = messagesKey('01KQK8R1111111111111111111');
    const page = messagesFromListPage({
      messages: fullPage('01KQK8R'),
      hasMore: true,
      nextCursor: 'server-cursor-after-01KQK8R',
    });
    queryClient.setQueryData<MessageInfiniteData>(queryKey, {
      pageParams: [undefined],
      pages: [page],
    });

    removeMessageFromCache(queryClient, queryKey, page.messages[0]?.id ?? '');

    const result = queryClient.getQueryData<MessageInfiniteData>(queryKey);
    expect(getNextMessagesPageParam(result?.pages[0] ?? messagePage([]))).toBe(
      'server-cursor-after-01KQK8R'
    );
  });
});

describe('send message cache settlement', () => {
  it('orders settled messages without Array.prototype.toSorted for Hermes clients', () => {
    const originalToSorted = Array.prototype.toSorted;
    Object.defineProperty(Array.prototype, 'toSorted', {
      configurable: true,
      value: undefined,
    });

    try {
      const pendingMessage = message({
        id: 'pending-01KQK8Y1111111111111111111',
        senderId: 'user-current',
        content: textContent('still sending'),
      });
      const olderServerMessage = message({ id: '01KQK8Y2222222222222222222' });
      const middleServerMessage = message({ id: '01KQK8Y3333333333333333333' });
      const newestServerMessage = message({ id: '01KQK8Y4444444444444444444' });
      const initial: MessageInfiniteData = {
        pageParams: [undefined],
        pages: [messagePage([pendingMessage, olderServerMessage, middleServerMessage])],
      };

      const result = applyCreateMessageResponseToPages(initial, 'pending-missing', {
        messageId: newestServerMessage.id,
        clientId: '01KQK8Y5555555555555555555',
        message: newestServerMessage,
      });

      expect(result.pages[0]?.messages.map(({ id }) => id)).toEqual([
        newestServerMessage.id,
        pendingMessage.id,
        middleServerMessage.id,
        olderServerMessage.id,
      ]);
    } finally {
      Object.defineProperty(Array.prototype, 'toSorted', {
        configurable: true,
        value: originalToSorted,
      });
    }
  });

  it('creates the first page for an optimistic send when the messages cache is cold', () => {
    const queryClient = new QueryClient();
    const queryKey = messagesKey('01KQK8Y0000000000000000000');
    const optimisticMessage = message({
      id: 'pending-01KQK8Y1111111111111111111',
      senderId: 'user-current',
      content: textContent('sent before load'),
    });

    queryClient.setQueryData<MessageInfiniteData>(queryKey, old =>
      applyOptimisticMessageToPages(old, optimisticMessage)
    );

    const result = queryClient.getQueryData<MessageInfiniteData>(queryKey);
    expect(result).toEqual({
      pageParams: [undefined],
      pages: [messagePage([optimisticMessage])],
    });
  });

  it('creates the first page for send success when no pending row was cached', () => {
    const queryClient = new QueryClient();
    const queryKey = messagesKey('01KQK8Y0000000000000000001');
    const serverMessage = message({
      id: '01KQK8Y2222222222222222222',
      senderId: 'user-current',
      content: textContent('server settled'),
    });

    queryClient.setQueryData<MessageInfiniteData>(queryKey, old =>
      applyCreateMessageResponseToPages(old ?? createEmptyMessageInfiniteData(), 'pending', {
        messageId: serverMessage.id,
        clientId: '01KQK8Y1111111111111111111',
        message: serverMessage,
      })
    );

    const result = queryClient.getQueryData<MessageInfiniteData>(queryKey);
    expect(result).toEqual({
      pageParams: [undefined],
      pages: [messagePage([serverMessage])],
    });
  });

  it('invalidates messages after a cold-cache send settles', () => {
    const queryClient = new QueryClient();
    const queryKey = messagesKey('01KQK8Y0000000000000000002');
    const pendingId = 'pending-01KQK8Y1111111111111111112';
    const optimisticMessage = message({
      id: pendingId,
      senderId: 'user-current',
      content: textContent('sent before history loads'),
    });
    const serverMessage = message({
      id: '01KQK8Y2222222222222222223',
      senderId: 'user-current',
      content: textContent('server settled'),
    });

    const context = applyOptimisticSendMessageToCache(
      queryClient,
      queryKey,
      pendingId,
      optimisticMessage
    );
    settleSendMessageSuccess(
      queryClient,
      {
        messageId: serverMessage.id,
        clientId: '01KQK8Y1111111111111111112',
        message: serverMessage,
      },
      context
    );

    const result = queryClient.getQueryData<MessageInfiniteData>(queryKey);
    expect(result).toEqual({
      pageParams: [undefined],
      pages: [messagePage([serverMessage])],
    });
    expect(queryClient.getQueryState(queryKey)?.isInvalidated).toBe(true);
  });

  it('creates the first page for message.created events when the messages cache is cold', () => {
    const queryClient = new QueryClient();
    const queryKey = messagesKey('01KQK8Z0000000000000000000');

    queryClient.setQueryData<MessageInfiniteData>(queryKey, old =>
      applyMessageCreatedEventToPages(old ?? createEmptyMessageInfiniteData(), {
        messageId: '01KQK8Z2222222222222222222',
        senderId: 'user-current',
        content: textContent('event settled'),
        inReplyToMessageId: null,
        replyTo: null,
        clientId: null,
      })
    );

    const result = queryClient.getQueryData<MessageInfiniteData>(queryKey);
    expect(result).toEqual({
      pageParams: [undefined],
      pages: [
        messagePage([
          message({
            id: '01KQK8Z2222222222222222222',
            senderId: 'user-current',
            content: textContent('event settled'),
          }),
        ]),
      ],
    });
  });

  it('replaces a pending reply with the canonical server message before the live event', () => {
    const pendingId = 'pending-01KQK8H1111111111111111111';
    const serverMessage = message({
      id: '01KQK8H2222222222222222222',
      senderId: 'user-current',
      content: [{ type: 'text', text: 'reply from server' }],
      inReplyToMessageId: '01KQK8H0000000000000000000',
      replyTo: {
        messageId: '01KQK8H0000000000000000000',
        senderId: 'bot-parent',
        deleted: false,
        previewText: 'parent context',
      },
    });
    const initial: MessageInfiniteData = {
      pageParams: [undefined],
      pages: [
        messagePage([
          message({
            id: pendingId,
            senderId: 'user-current',
            content: [{ type: 'text', text: 'reply from server' }],
            inReplyToMessageId: '01KQK8H0000000000000000000',
            replyTo: null,
          }),
        ]),
      ],
    };

    const fromResponse = applyCreateMessageResponseToPages(initial, pendingId, {
      messageId: serverMessage.id,
      clientId: '01KQK8H1111111111111111111',
      message: serverMessage,
    });
    const fromEvent = applyMessageCreatedEventToPages(fromResponse, {
      messageId: serverMessage.id,
      senderId: serverMessage.senderId,
      content: serverMessage.content,
      inReplyToMessageId: serverMessage.inReplyToMessageId,
      replyTo: serverMessage.replyTo,
      clientId: '01KQK8H1111111111111111111',
    });

    expect(fromResponse.pages[0]?.messages).toEqual([serverMessage]);
    expect(fromEvent.pages[0]?.messages).toEqual([serverMessage]);
  });
});

describe('execute action cache settlement', () => {
  it('replaces optimistic resolved content with the server response', () => {
    const messageId = '01KQK8H2222222222222222222';
    const initial: MessageInfiniteData = {
      pageParams: [undefined],
      pages: [
        messagePage([
          message({
            id: messageId,
            content: [
              {
                type: 'actions',
                groupId: 'approval',
                actions: [{ value: 'deny', label: 'Deny', style: 'danger' }],
                resolved: { value: 'deny', resolvedBy: 'user-1', resolvedAt: 1 },
              },
            ],
          }),
        ]),
      ],
    };

    const result = applyExecuteActionResponseToPages(initial, {
      ok: true,
      messageId,
      content: [
        {
          type: 'actions',
          groupId: 'approval',
          actions: [{ value: 'deny', label: 'Deny', style: 'danger' }],
          resolved: { value: 'deny', resolvedBy: 'user-1', resolvedAt: 2 },
        },
      ],
      resolved: {
        groupId: 'approval',
        value: 'deny',
        resolvedBy: 'user-1',
        resolvedAt: 2,
      },
    });

    expect(result.pages[0]?.messages[0]?.content).toEqual([
      {
        type: 'actions',
        groupId: 'approval',
        actions: [{ value: 'deny', label: 'Deny', style: 'danger' }],
        resolved: { value: 'deny', resolvedBy: 'user-1', resolvedAt: 2 },
      },
    ]);
  });
});
