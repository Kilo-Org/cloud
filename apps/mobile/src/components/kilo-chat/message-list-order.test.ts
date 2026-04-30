import { describe, expect, it } from 'vitest';
import { type Message } from '@kilocode/kilo-chat';

import { getFlashListMessages } from './message-list-order';

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

describe('getFlashListMessages', () => {
  it('keeps oldest-to-newest messages in chronological order', () => {
    const messages = [message('oldest'), message('middle'), message('newest')];

    expect(getFlashListMessages(messages).map(m => m.id)).toEqual(['oldest', 'middle', 'newest']);
  });
});
