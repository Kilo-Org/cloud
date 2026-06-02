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
    expect(
      canSubmitMessageInput({
        currentUserId: null,
        canSend: true,
        overLimit: false,
        text: 'hello',
        readyAttachmentCount: 0,
        isUploading: false,
        hasFailedAttachments: false,
      })
    ).toBe(false);
    expect(
      canSubmitMessageInput({
        currentUserId: 'user-1',
        canSend: true,
        overLimit: false,
        text: 'hello',
        readyAttachmentCount: 0,
        isUploading: false,
        hasFailedAttachments: false,
      })
    ).toBe(true);
  });

  it('blocks unavailable, empty, and over-limit sends', () => {
    expect(
      canSubmitMessageInput({
        currentUserId: 'user-1',
        canSend: false,
        overLimit: false,
        text: 'hello',
        readyAttachmentCount: 0,
        isUploading: false,
        hasFailedAttachments: false,
      })
    ).toBe(false);
    expect(
      canSubmitMessageInput({
        currentUserId: 'user-1',
        canSend: true,
        overLimit: false,
        text: '   ',
        readyAttachmentCount: 0,
        isUploading: false,
        hasFailedAttachments: false,
      })
    ).toBe(false);
    expect(
      canSubmitMessageInput({
        currentUserId: 'user-1',
        canSend: true,
        overLimit: true,
        text: 'x'.repeat(MESSAGE_TEXT_MAX_CHARS + 1),
        readyAttachmentCount: 0,
        isUploading: false,
        hasFailedAttachments: false,
      })
    ).toBe(false);
  });
});

describe('canSubmitMessageInput with attachments', () => {
  it('allows submit with text only', () => {
    expect(
      canSubmitMessageInput({
        currentUserId: 'user-1',
        canSend: true,
        overLimit: false,
        text: 'hi',
        readyAttachmentCount: 0,
        isUploading: false,
        hasFailedAttachments: false,
      })
    ).toBe(true);
  });

  it('allows submit with attachments only and blank text', () => {
    expect(
      canSubmitMessageInput({
        currentUserId: 'user-1',
        canSend: true,
        overLimit: false,
        text: '',
        readyAttachmentCount: 1,
        isUploading: false,
        hasFailedAttachments: false,
      })
    ).toBe(true);
  });

  it('blocks submit while any upload is in progress', () => {
    expect(
      canSubmitMessageInput({
        currentUserId: 'user-1',
        canSend: true,
        overLimit: false,
        text: 'hi',
        readyAttachmentCount: 0,
        isUploading: true,
        hasFailedAttachments: false,
      })
    ).toBe(false);
  });

  it('blocks submit while any attachment failed', () => {
    expect(
      canSubmitMessageInput({
        currentUserId: 'user-1',
        canSend: true,
        overLimit: false,
        text: 'hi',
        readyAttachmentCount: 1,
        isUploading: false,
        hasFailedAttachments: true,
      })
    ).toBe(false);
  });

  it('blocks submit with empty text and no ready attachments', () => {
    expect(
      canSubmitMessageInput({
        currentUserId: 'user-1',
        canSend: true,
        overLimit: false,
        text: '   ',
        readyAttachmentCount: 0,
        isUploading: false,
        hasFailedAttachments: false,
      })
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
