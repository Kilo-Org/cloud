import { describe, expect, it } from 'vitest';

import { buildMessageActionSheetOptions } from './message-actions';

describe('buildMessageActionSheetOptions', () => {
  it('offers first-reaction choices for messages with no reactions', () => {
    const options = buildMessageActionSheetOptions({
      isOwnMessage: false,
      canReact: true,
      canReply: true,
    });

    expect(options.options).toContain('👍 React');
    expect(options.options).toContain('❤️ React');
    expect(options.cancelButtonIndex).toBe(options.options.length - 1);
  });

  it('offers edit and delete actions only for own messages', () => {
    const ownOptions = buildMessageActionSheetOptions({
      isOwnMessage: true,
      canReact: true,
      canReply: true,
    });
    const otherOptions = buildMessageActionSheetOptions({
      isOwnMessage: false,
      canReact: true,
      canReply: true,
    });

    expect(ownOptions.options).toContain('Edit');
    expect(ownOptions.options).toContain('Delete');
    expect(ownOptions.destructiveButtonIndex).toBe(ownOptions.options.indexOf('Delete'));
    expect(otherOptions.options).not.toContain('Edit');
    expect(otherOptions.options).not.toContain('Delete');
    expect(otherOptions.destructiveButtonIndex).toBeUndefined();
  });

  it('offers reply only when allowed for the message', () => {
    const replyableOptions = buildMessageActionSheetOptions({
      isOwnMessage: false,
      canReact: true,
      canReply: true,
    });
    const failedDeliveryOptions = buildMessageActionSheetOptions({
      isOwnMessage: false,
      canReact: true,
      canReply: false,
    });

    expect(replyableOptions.options).toContain('Reply');
    expect(failedDeliveryOptions.options).not.toContain('Reply');
  });
});
