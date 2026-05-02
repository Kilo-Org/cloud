import { describe, expect, it } from 'vitest';
import { QueryClient, type InfiniteData } from '@tanstack/react-query';
import { KiloChatApiError, type Message } from '@kilocode/kilo-chat';
import {
  applyExecuteActionResponseToPages,
  applyCreateMessageResponseToPages,
  applyMessageCreatedEventToPages,
  applyReactionAddedEventToPages,
  applyReactionRemovedResponseToPages,
  applyReactionRemovedMutationToPages,
  createReactionOperationTracker,
  getNextMessagesPageParam,
  messagesFromListPage,
  rollbackEditMessageError,
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

describe('reaction operation ordering', () => {
  it('keeps a successful local remove ahead of an older delayed add event', () => {
    const conversationId = '01KQK8A1111111111111111111';
    const messageId = '01KQK8A2222222222222222222';
    const currentUserId = 'user-current';
    const tracker = createReactionOperationTracker();
    const initial: InfiniteData<Message[]> = {
      pageParams: [undefined],
      pages: [
        [
          message({
            id: messageId,
            reactions: [{ emoji: '👍', count: 1, memberIds: [currentUserId] }],
          }),
        ],
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

    expect(afterDelayedAdd.pages[0]?.[0]?.reactions).toEqual([]);
  });

  it('keeps a no-op remove tombstone ahead of an older delayed add event', () => {
    const conversationId = '01KQK8C1111111111111111111';
    const messageId = '01KQK8C2222222222222222222';
    const currentUserId = 'user-current';
    const tracker = createReactionOperationTracker();
    const initial: InfiniteData<Message[]> = {
      pageParams: [undefined],
      pages: [
        [
          message({
            id: messageId,
            reactions: [{ emoji: '👍', count: 1, memberIds: [currentUserId] }],
          }),
        ],
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

    expect(afterDelayedAdd.pages[0]?.[0]?.reactions).toEqual([]);
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
    queryClient.setQueryData<InfiniteData<Message[]>>(queryKey, {
      pageParams: [undefined],
      pages: [[optimistic]],
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

    const result = queryClient.getQueryData<InfiniteData<Message[]>>(queryKey);
    const query = queryClient.getQueryCache().find({ queryKey });
    expect(result?.pages[0]?.[0]).toEqual(original);
    expect(query?.state.isInvalidated).toBe(true);
  });
});

describe('message pagination helpers', () => {
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
    const initial: InfiniteData<Message[]> = {
      pageParams: [undefined],
      pages: [
        [
          message({
            id: pendingId,
            senderId: 'user-current',
            content: [{ type: 'text', text: 'reply from server' }],
            inReplyToMessageId: '01KQK8H0000000000000000000',
            replyTo: null,
          }),
        ],
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

    expect(fromResponse.pages[0]).toEqual([serverMessage]);
    expect(fromEvent.pages[0]).toEqual([serverMessage]);
  });
});

describe('execute action cache settlement', () => {
  it('replaces optimistic resolved content with the server response', () => {
    const messageId = '01KQK8H2222222222222222222';
    const initial: InfiniteData<Message[]> = {
      pageParams: [undefined],
      pages: [
        [
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
        ],
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

    expect(result.pages[0]?.[0]?.content).toEqual([
      {
        type: 'actions',
        groupId: 'approval',
        actions: [{ value: 'deny', label: 'Deny', style: 'danger' }],
        resolved: { value: 'deny', resolvedBy: 'user-1', resolvedAt: 2 },
      },
    ]);
  });
});
