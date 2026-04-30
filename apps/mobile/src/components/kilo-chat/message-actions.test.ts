import { describe, expect, it } from 'vitest';
import { type Message } from '@kilocode/kilo-chat';

import {
  canEditOrDeleteMessage,
  deliveryFailureTextForMessage,
  editableTextForMessage,
} from './message-actions';

function message(overrides: Partial<Message> = {}): Message {
  return {
    id: 'message-1',
    senderId: 'user-1',
    content: [{ type: 'text', text: 'hello' }],
    inReplyToMessageId: null,
    updatedAt: null,
    clientUpdatedAt: null,
    version: 1,
    deleted: false,
    deliveryFailed: false,
    reactions: [],
    ...overrides,
  };
}

describe('message actions', () => {
  it('only allows edit/delete for the current user non-deleted messages', () => {
    expect(canEditOrDeleteMessage(message(), 'user-1')).toBe(true);
    expect(canEditOrDeleteMessage(message(), 'user-2')).toBe(false);
    expect(canEditOrDeleteMessage(message({ deleted: true }), 'user-1')).toBe(false);
    expect(canEditOrDeleteMessage(message({ id: 'pending-client-id' }), 'user-1')).toBe(false);
    expect(canEditOrDeleteMessage(message({ deliveryFailed: true }), 'user-1')).toBe(false);
  });

  it('extracts editable text only from text-only messages', () => {
    expect(
      editableTextForMessage(
        message({
          content: [
            { type: 'text', text: 'first' },
            { type: 'text', text: 'second' },
          ],
        })
      )
    ).toBe('first\nsecond');

    expect(
      editableTextForMessage(
        message({
          content: [
            {
              type: 'actions',
              groupId: 'approval',
              actions: [{ label: 'Approve', value: 'allow-once', style: 'primary' }],
            },
          ],
        })
      )
    ).toBeNull();
  });

  it('exposes visible text for failed delivery messages', () => {
    expect(deliveryFailureTextForMessage(message())).toBeNull();
    expect(deliveryFailureTextForMessage(message({ deliveryFailed: true }))).toBe(
      'Not delivered to bot'
    );
  });
});
