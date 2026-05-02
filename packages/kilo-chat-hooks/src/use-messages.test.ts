import { describe, expect, it } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import { KiloChatApiError, type Message, type MessageListResponse } from '@kilocode/kilo-chat';
import {
  applyExecuteActionResponseToPages,
  applyCreateMessageResponseToPages,
  applyMessageCreatedEventToPages,
  type MessageInfiniteData,
  applyReactionAddedEventToPages,
  applyReactionRemovedResponseToPages,
  applyReactionRemovedMutationToPages,
  createReactionOperationTracker,
  getNextMessagesPageParam,
  messagesFromListPage,
  removeMessageFromCache,
  rollbackEditMessageError,
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
