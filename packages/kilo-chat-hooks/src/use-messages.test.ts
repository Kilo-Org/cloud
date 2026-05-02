import { describe, expect, it } from 'vitest';
import type { InfiniteData } from '@tanstack/react-query';
import type { Message } from '@kilocode/kilo-chat';
import {
  applyReactionAddedEventToPages,
  applyReactionRemovedMutationToPages,
  createReactionOperationTracker,
} from './use-messages';

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
});
