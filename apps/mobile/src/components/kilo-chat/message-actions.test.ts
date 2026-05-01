import { describe, expect, it } from 'vitest';

import { buildMessageActionSheetOptions, getSelectedMessageAction } from './message-actions';

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

  it('keeps reply as the first action when reactions are disabled', () => {
    const actionSheet = buildMessageActionSheetOptions({
      isOwnMessage: false,
      canReact: false,
      canReply: true,
    });

    expect(actionSheet.options).toEqual(['Reply', 'Cancel']);
    expect(actionSheet.actions[0]).toEqual({ kind: 'reply', label: 'Reply' });
  });

  it('resolves selected action by action identity instead of raw option index', () => {
    const actionSheet = buildMessageActionSheetOptions({
      isOwnMessage: false,
      canReact: false,
      canReply: true,
    });

    const selectedAction = getSelectedMessageAction(actionSheet, 0);

    expect(selectedAction).toEqual({ kind: 'reply', label: 'Reply' });
    expect(selectedAction?.kind).not.toBe('reaction');
  });
});
