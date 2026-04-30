import { describe, expect, it } from 'vitest';

import { conversationEventSubscriptionContext } from './conversation-event-subscription-context';

describe('conversationEventSubscriptionContext', () => {
  it('returns no event subscription while the route is not active and focused', () => {
    expect(conversationEventSubscriptionContext('sandbox-1', 'conversation-1', false)).toBeNull();
  });

  it('returns the conversation context only while active and focused', () => {
    expect(conversationEventSubscriptionContext('sandbox-1', 'conversation-1', true)).toBe(
      '/kiloclaw/sandbox-1/conversation-1'
    );
  });
});
