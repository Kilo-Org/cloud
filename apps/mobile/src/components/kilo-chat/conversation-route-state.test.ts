import { KiloChatApiError } from '@kilocode/kilo-chat';
import { describe, expect, it } from 'vitest';

import {
  getConversationRouteErrorMessage,
  shouldRenderConversationScreen,
} from './conversation-route-state';

describe('getConversationRouteErrorMessage', () => {
  it('uses the not-found message for forbidden conversation detail errors', () => {
    expect(getConversationRouteErrorMessage(new KiloChatApiError(403, {}))).toBe(
      'Conversation not found'
    );
  });

  it('uses a generic message for non-API load failures', () => {
    expect(getConversationRouteErrorMessage(new Error('network down'))).toBe(
      'Failed to load conversation'
    );
  });
});

describe('shouldRenderConversationScreen', () => {
  it('does not render while the conversation detail is loading', () => {
    expect(shouldRenderConversationScreen({ data: undefined, isError: false })).toBe(false);
  });

  it('renders after conversation detail loads successfully', () => {
    expect(
      shouldRenderConversationScreen({
        data: { title: 'Kilo Chat' },
        isError: false,
      })
    ).toBe(true);
  });
});
