import { describe, expect, it } from 'vitest';

import { buildMessageActionSheetOptions, getSelectedMessageAction } from './message-actions';

describe('buildMessageActionSheetOptions', () => {
  it('offers first-reaction choices for messages with no reactions', () => {
    const options = buildMessageActionSheetOptions({
      canReact: true,
      canReply: true,
      canCopy: true,
      canEdit: false,
      canDelete: false,
    });

    expect(options.options).toContain('👍');
    expect(options.options).toContain('❤️');
    expect(options.options).not.toContain('👍 React');
    expect(options.cancelButtonIndex).toBe(options.options.length - 1);
  });

  it('offers edit and delete actions only for own messages', () => {
    const ownOptions = buildMessageActionSheetOptions({
      canReact: true,
      canReply: true,
      canCopy: true,
      canEdit: true,
      canDelete: true,
    });
    const otherOptions = buildMessageActionSheetOptions({
      canReact: true,
      canReply: true,
      canCopy: true,
      canEdit: false,
      canDelete: false,
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
      canReact: true,
      canReply: true,
      canCopy: true,
      canEdit: false,
      canDelete: false,
    });
    const failedDeliveryOptions = buildMessageActionSheetOptions({
      canReact: true,
      canReply: false,
      canCopy: true,
      canEdit: false,
      canDelete: false,
    });

    expect(replyableOptions.options).toContain('Reply');
    expect(failedDeliveryOptions.options).not.toContain('Reply');
  });

  it('keeps reply as the first action when reactions are disabled', () => {
    const actionSheet = buildMessageActionSheetOptions({
      canReact: false,
      canReply: true,
      canCopy: false,
      canEdit: false,
      canDelete: false,
    });

    expect(actionSheet.options).toEqual(['Reply', 'Cancel']);
    expect(actionSheet.actions[0]).toEqual({ kind: 'reply', label: 'Reply' });
  });

  it('resolves selected action by action identity instead of raw option index', () => {
    const actionSheet = buildMessageActionSheetOptions({
      canReact: false,
      canReply: true,
      canCopy: false,
      canEdit: false,
      canDelete: false,
    });

    const selectedAction = getSelectedMessageAction(actionSheet, 0);

    expect(selectedAction).toEqual({ kind: 'reply', label: 'Reply' });
    expect(selectedAction?.kind).not.toBe('reaction');
  });

  it('offers no API-backed actions for pending messages', () => {
    const actionSheet = buildMessageActionSheetOptions({
      canReact: true,
      canReply: true,
      canCopy: false,
      canEdit: true,
      canDelete: true,
      isPendingMessage: true,
    });

    expect(actionSheet.options).toEqual(['Cancel']);
    expect(actionSheet.actions.every(action => action.kind === 'cancel')).toBe(true);
    expect(actionSheet.destructiveButtonIndex).toBeUndefined();
    expect(getSelectedMessageAction(actionSheet, 0)).toBeNull();
  });

  it('offers delete and cancel only for own delivery-failed messages', () => {
    const actionSheet = buildMessageActionSheetOptions({
      canReact: false,
      canReply: false,
      canCopy: true,
      canEdit: false,
      canDelete: true,
    });

    expect(actionSheet.options).toEqual(['Copy', 'Delete', 'Cancel']);
    expect(actionSheet.destructiveButtonIndex).toBe(1);
  });

  it('offers cancel only for non-own delivery-failed messages', () => {
    const actionSheet = buildMessageActionSheetOptions({
      canReact: false,
      canReply: false,
      canCopy: false,
      canEdit: false,
      canDelete: false,
    });

    expect(actionSheet.options).toEqual(['Cancel']);
    expect(actionSheet.destructiveButtonIndex).toBeUndefined();
  });

  it('orders reactions, reply, copy, edit, delete, then cancel', () => {
    const actionSheet = buildMessageActionSheetOptions({
      canReact: true,
      canReply: true,
      canCopy: true,
      canEdit: true,
      canDelete: true,
    });

    expect(actionSheet.options).toEqual([
      '👍',
      '❤️',
      '😂',
      '🎉',
      'More reactions',
      'Reply',
      'Copy',
      'Edit',
      'Delete',
      'Cancel',
    ]);
  });
});
