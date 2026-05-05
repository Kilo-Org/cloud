import { describe, expect, it } from 'vitest';
import { type Message } from '@kilocode/kilo-chat';

import {
  applyReactionAddedEventToPages,
  applyReactionRemovedEventToPages,
  createReactionOperationTracker,
  type MessageInfiniteData,
} from '@kilocode/kilo-chat-hooks';

function message(id: string, reactions: Message['reactions'] = []): Message {
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
    reactions,
  };
}

function pages(cachedMessage: Message): MessageInfiniteData {
  return {
    pages: [{ messages: [cachedMessage], hasMore: false, nextCursor: null }],
    pageParams: [undefined],
  };
}

describe('reaction operation cache ordering', () => {
  it('ignores an older reaction add after a newer remove for the same member', () => {
    const tracker = createReactionOperationTracker();
    const data = pages(message('m1', [{ emoji: '👍', count: 1, memberIds: ['user-1'] }]));

    const afterRemove = applyReactionRemovedEventToPages(data, 'conversation-1', tracker, {
      messageId: 'm1',
      operationId: '01HX0000000000000000000002',
      emoji: '👍',
      memberId: 'user-1',
    });
    const afterStaleAdd = applyReactionAddedEventToPages(afterRemove, 'conversation-1', tracker, {
      messageId: 'm1',
      operationId: '01HX0000000000000000000001',
      emoji: '👍',
      memberId: 'user-1',
    });

    expect(afterStaleAdd.pages[0]?.messages[0]?.reactions).toEqual([]);
  });

  it('applies a newer reaction add after an older remove for the same member', () => {
    const tracker = createReactionOperationTracker();
    const data = pages(message('m1'));

    const afterRemove = applyReactionRemovedEventToPages(data, 'conversation-1', tracker, {
      messageId: 'm1',
      operationId: '01HX0000000000000000000001',
      emoji: '👍',
      memberId: 'user-1',
    });
    const afterAdd = applyReactionAddedEventToPages(afterRemove, 'conversation-1', tracker, {
      messageId: 'm1',
      operationId: '01HX0000000000000000000002',
      emoji: '👍',
      memberId: 'user-1',
    });

    expect(afterAdd.pages[0]?.messages[0]?.reactions).toEqual([
      { emoji: '👍', count: 1, memberIds: ['user-1'] },
    ]);
  });

  it("does not suppress another member's reaction with a newer operation", () => {
    const tracker = createReactionOperationTracker();
    const data = pages(message('m1'));

    const afterUserOne = applyReactionAddedEventToPages(data, 'conversation-1', tracker, {
      messageId: 'm1',
      operationId: '01HX0000000000000000000002',
      emoji: '👍',
      memberId: 'user-1',
    });
    const afterUserTwo = applyReactionAddedEventToPages(afterUserOne, 'conversation-1', tracker, {
      messageId: 'm1',
      operationId: '01HX0000000000000000000001',
      emoji: '👍',
      memberId: 'user-2',
    });

    expect(afterUserTwo.pages[0]?.messages[0]?.reactions).toEqual([
      { emoji: '👍', count: 2, memberIds: ['user-1', 'user-2'] },
    ]);
  });
});
