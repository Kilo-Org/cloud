import { describe, expect, it } from 'vitest';
import { createMessageRequestSchema, type Message } from '@kilocode/kilo-chat';

import {
  buildSendMessageVariables,
  createSendMessageClientId,
  getDeliveryFailureLabel,
  getReplyPreviewText,
} from './message-presentation';

function message(overrides: Partial<Message> = {}): Message {
  return {
    id: 'message-1',
    senderId: 'user-1',
    content: [{ type: 'text', text: 'hello' }],
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

describe('buildSendMessageVariables', () => {
  it('builds variables accepted by the create message request schema', () => {
    const variables = buildSendMessageVariables({
      conversationId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
      text: 'mobile message',
      clientId: createSendMessageClientId(),
    });

    expect(createMessageRequestSchema.safeParse(variables).success).toBe(true);
  });

  it('includes inReplyToMessageId when sending a reply', () => {
    expect(
      buildSendMessageVariables({
        conversationId: 'conversation-1',
        text: 'reply body',
        clientId: 'client-1',
        inReplyToMessageId: 'parent-1',
      })
    ).toEqual({
      conversationId: 'conversation-1',
      content: [{ type: 'text', text: 'reply body' }],
      clientId: 'client-1',
      inReplyToMessageId: 'parent-1',
    });
  });
});

describe('getReplyPreviewText', () => {
  it('uses parent text for a reply preview', () => {
    expect(getReplyPreviewText(message({ content: [{ type: 'text', text: 'parent text' }] }))).toBe(
      'parent text'
    );
  });

  it('uses a deleted-message label for deleted parents', () => {
    expect(getReplyPreviewText(message({ deleted: true }))).toBe('[deleted message]');
  });

  it('uses unloaded parent snapshot text for a reply preview', () => {
    expect(
      getReplyPreviewText({
        messageId: 'parent-1',
        senderId: 'user-1',
        deleted: false,
        previewText: 'snapshot parent text',
      })
    ).toBe('snapshot parent text');
  });
});

describe('getDeliveryFailureLabel', () => {
  it('returns a visible failure label for failed delivery messages', () => {
    expect(getDeliveryFailureLabel(message({ deliveryFailed: true }))).toBe('Not delivered');
  });
});
