import { describe, expect, it } from 'vitest';

import {
  isMessageListAtBottom,
  messageListNewestScrollKey,
  shouldScrollToNewestAfterMessagesChange,
} from './message-list-scroll-state';
import { type Message } from '@kilocode/kilo-chat';

const newestMessage = {
  id: 'message-2',
  senderId: 'bot-1',
  content: [{ type: 'text', text: 'first draft' }],
  inReplyToMessageId: null,
  replyTo: null,
  updatedAt: 10,
  clientUpdatedAt: null,
  deleted: false,
  deliveryFailed: false,
  reactions: [],
} satisfies Message;

describe('message list scroll state', () => {
  it('detects whether the visible viewport is at the bottom', () => {
    expect(
      isMessageListAtBottom({
        contentHeight: 1200,
        viewportHeight: 500,
        offsetY: 700,
      })
    ).toBe(true);

    expect(
      isMessageListAtBottom({
        contentHeight: 1200,
        viewportHeight: 500,
        offsetY: 650,
      })
    ).toBe(false);
  });

  it('scrolls after newest-message changes only when the user was already at bottom', () => {
    expect(
      shouldScrollToNewestAfterMessagesChange({
        newestMessageKey: 'message-2',
        previousNewestMessageKey: 'message-1',
        wasAtBottom: true,
      })
    ).toBe(true);

    expect(
      shouldScrollToNewestAfterMessagesChange({
        newestMessageKey: 'message-2',
        previousNewestMessageKey: 'message-1',
        wasAtBottom: false,
      })
    ).toBe(false);

    expect(
      shouldScrollToNewestAfterMessagesChange({
        newestMessageKey: 'message-2',
        previousNewestMessageKey: 'message-2',
        wasAtBottom: true,
      })
    ).toBe(false);
  });

  it('keeps scrolling while newest-message auto-follow is active', () => {
    const params = {
      newestMessageKey: 'message-2-edit',
      previousNewestMessageKey: 'message-2',
      wasAtBottom: false,
      isAutoFollowingNewest: true,
    };

    expect(shouldScrollToNewestAfterMessagesChange(params)).toBe(true);
  });

  it('changes the newest scroll key when the newest message is edited', () => {
    expect(messageListNewestScrollKey(newestMessage)).not.toBe(
      messageListNewestScrollKey({
        ...newestMessage,
        content: [{ type: 'text', text: 'edited draft' }],
        updatedAt: 20,
      })
    );
  });
});
