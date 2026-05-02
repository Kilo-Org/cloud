import { MESSAGE_TEXT_MAX_CHARS, type Message } from '@kilocode/kilo-chat';

import { canSubmitMessageInput, nextMessageInputStateAfterSend } from './MessageInput';

function message(overrides: Partial<Message> = {}): Message {
  return {
    id: 'message-1',
    senderId: 'user-1',
    content: [{ type: 'text', text: 'original' }],
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

describe('canSubmitMessageInput', () => {
  it('waits for the current user id before allowing submit', () => {
    expect(canSubmitMessageInput(null, true, false, 'hello')).toBe(false);
    expect(canSubmitMessageInput('user-1', true, false, 'hello')).toBe(true);
  });

  it('blocks unavailable, empty, and over-limit sends', () => {
    expect(canSubmitMessageInput('user-1', false, false, 'hello')).toBe(false);
    expect(canSubmitMessageInput('user-1', true, false, '   ')).toBe(false);
    expect(
      canSubmitMessageInput('user-1', true, true, 'x'.repeat(MESSAGE_TEXT_MAX_CHARS + 1))
    ).toBe(false);
  });
});

describe('nextMessageInputStateAfterSend', () => {
  it('preserves draft text and reply target after failed send', () => {
    const replyingTo = message({ id: 'reply-target' });

    expect(nextMessageInputStateAfterSend({ text: 'retry me', replyingTo }, false)).toStrictEqual({
      text: 'retry me',
      replyingTo,
    });
  });
});
