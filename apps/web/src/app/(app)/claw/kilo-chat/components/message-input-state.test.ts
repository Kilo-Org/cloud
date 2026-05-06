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

    expect(
      nextMessageInputStateAfterSend(
        { text: 'retry me', replyingTo },
        { text: 'retry me', replyingTo },
        false
      )
    ).toStrictEqual({ text: 'retry me', replyingTo });
  });

  it('keeps a newer draft after a deferred send succeeds', () => {
    expect(
      nextMessageInputStateAfterSend(
        { text: 'newer draft', replyingTo: null },
        { text: 'sent draft', replyingTo: null },
        true
      )
    ).toStrictEqual({ text: 'newer draft', replyingTo: null });
  });

  it('keeps a newer draft after a deferred send fails', () => {
    expect(
      nextMessageInputStateAfterSend(
        { text: 'newer draft', replyingTo: null },
        { text: 'sent draft', replyingTo: null },
        false
      )
    ).toStrictEqual({ text: 'newer draft', replyingTo: null });
  });

  it('keeps a newer reply target after a deferred send succeeds', () => {
    const submittedReply = message({ id: 'submitted-reply' });
    const newerReply = message({ id: 'newer-reply' });

    expect(
      nextMessageInputStateAfterSend(
        { text: 'sent draft', replyingTo: newerReply },
        { text: 'sent draft', replyingTo: submittedReply },
        true
      )
    ).toStrictEqual({ text: '', replyingTo: newerReply });
  });
});
