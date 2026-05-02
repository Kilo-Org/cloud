import { describe, expect, it } from 'vitest';
import { QueryClient, type InfiniteData } from '@tanstack/react-query';
import { KiloChatApiError, type Message } from '@kilocode/kilo-chat';
import {
  applyReactionAddedEventToPages,
  applyReactionRemovedResponseToPages,
  applyReactionRemovedMutationToPages,
  createReactionOperationTracker,
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
