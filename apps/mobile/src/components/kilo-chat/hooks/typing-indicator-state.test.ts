import { describe, expect, it } from 'vitest';

import {
  applyTypingEventToMembers,
  type TypingEventKind,
  typingIndicatorLabel,
} from './typing-indicator-state';

describe('typing indicator state', () => {
  it('adds typing members only for the active conversation context', () => {
    const event: TypingEventKind = 'typing';

    expect(
      applyTypingEventToMembers([], {
        event,
        expectedContext: '/kiloclaw/sandbox-1/conversation-1',
        eventContext: '/kiloclaw/sandbox-1/conversation-1',
        memberId: 'bot:sandbox-1',
        currentUserId: 'user-1',
      })
    ).toEqual(['bot:sandbox-1']);

    expect(
      applyTypingEventToMembers([], {
        event,
        expectedContext: '/kiloclaw/sandbox-1/conversation-1',
        eventContext: '/kiloclaw/sandbox-1/other',
        memberId: 'bot:sandbox-1',
        currentUserId: 'user-1',
      })
    ).toEqual([]);
  });

  it('ignores the current user and removes members on stop', () => {
    expect(
      applyTypingEventToMembers([], {
        event: 'typing',
        expectedContext: '/kiloclaw/sandbox-1/conversation-1',
        eventContext: '/kiloclaw/sandbox-1/conversation-1',
        memberId: 'user-1',
        currentUserId: 'user-1',
      })
    ).toEqual([]);

    expect(
      applyTypingEventToMembers(['bot:sandbox-1'], {
        event: 'typing.stop',
        expectedContext: '/kiloclaw/sandbox-1/conversation-1',
        eventContext: '/kiloclaw/sandbox-1/conversation-1',
        memberId: 'bot:sandbox-1',
        currentUserId: 'user-1',
      })
    ).toEqual([]);
  });

  it('labels bot typing separately from human typing', () => {
    expect(typingIndicatorLabel(['bot:sandbox-1'])).toBe('Bot');
    expect(typingIndicatorLabel(['user-2'])).toBe('Someone');
    expect(typingIndicatorLabel([])).toBeUndefined();
  });
});
