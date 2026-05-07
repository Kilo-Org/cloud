import { describe, expect, it, vi } from 'vitest';
import { createMessageRequestSchema, type Message } from '@kilocode/kilo-chat';

import {
  buildSendMessageVariables,
  canShowReactionPills,
  canToggleReaction,
  createSendMessageClientId,
  getDeliveryFailureLabel,
  getReplyPreviewText,
  isMessageEdited,
  isMessageTextSelectionEnabled,
  resolveMessageAuthorLabel,
} from './message-presentation';

vi.mock('expo-crypto', () => ({
  getRandomValues: (typedArray: Uint8Array) => {
    typedArray[0] = 128;
    return typedArray;
  },
}));

vi.mock('ulid', () => ({
  ulid: (_seedTime?: number, prng?: () => number) => {
    if (!prng) {
      throw new Error('missing explicit PRNG');
    }
    prng();
    return '01ARZ3NDEKTSV4RRFFQ69G5FAV';
  },
}));

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
  it('creates client ids without relying on ULID PRNG auto-detection', () => {
    expect(createSendMessageClientId()).toBe('01ARZ3NDEKTSV4RRFFQ69G5FAV');
  });

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

describe('isMessageTextSelectionEnabled', () => {
  it('disables native text selection for chat messages', () => {
    expect(isMessageTextSelectionEnabled()).toBe(false);
  });
});

describe('isMessageEdited', () => {
  it('marks updated non-deleted messages as edited', () => {
    expect(isMessageEdited(message({ clientUpdatedAt: 123 }))).toBe(true);
  });

  it('hides edited state for deleted messages', () => {
    expect(isMessageEdited(message({ clientUpdatedAt: 123, deleted: true }))).toBe(false);
  });
});

describe('canShowReactionPills', () => {
  it('hides reactions for deleted messages', () => {
    expect(
      canShowReactionPills(
        message({
          deleted: true,
          reactions: [{ emoji: '👍', count: 1, memberIds: ['user-1'] }],
        })
      )
    ).toBe(false);
  });

  it('shows reactions for non-deleted messages with reactions', () => {
    expect(
      canShowReactionPills(
        message({
          reactions: [{ emoji: '👍', count: 1, memberIds: ['user-1'] }],
        })
      )
    ).toBe(true);
  });
});

describe('canToggleReaction', () => {
  it('blocks reaction toggles for deleted messages', () => {
    expect(canToggleReaction(message({ deleted: true }), 'user-1')).toBe(false);
  });

  it('blocks reaction toggles when the current user is not loaded', () => {
    expect(canToggleReaction(message(), null)).toBe(false);
  });

  it('allows reaction toggles for loaded users on delivered messages', () => {
    expect(canToggleReaction(message(), 'user-1')).toBe(true);
  });
});

describe('resolveMessageAuthorLabel', () => {
  it('uses resolved display names for user senders', () => {
    expect(
      resolveMessageAuthorLabel({
        senderId: 'user-1',
        members: [
          { id: 'user-1', kind: 'user', displayName: 'Igor Minar', avatarUrl: null },
          { id: 'bot:kiloclaw:sandbox-1', kind: 'bot', displayName: null, avatarUrl: null },
        ],
        botName: 'Helper Bot',
      })
    ).toBe('Igor Minar');
  });

  it('uses the bot display name for bot senders', () => {
    expect(
      resolveMessageAuthorLabel({
        senderId: 'bot:kiloclaw:sandbox-1',
        members: [
          { id: 'bot:kiloclaw:sandbox-1', kind: 'bot', displayName: null, avatarUrl: null },
        ],
        botName: 'Helper Bot',
      })
    ).toBe('Helper Bot');
  });

  it('falls back to stable labels when resolved names are missing', () => {
    expect(resolveMessageAuthorLabel({ senderId: 'bot:kiloclaw:sandbox-1' })).toBe('KiloClaw');
    expect(resolveMessageAuthorLabel({ senderId: 'user-1' })).toBe('user-1');
  });
});
