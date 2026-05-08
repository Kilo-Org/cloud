import { KiloChatApiError } from '@kilocode/kilo-chat';
import { describe, expect, it } from 'vitest';

import {
  getConversationRouteDecision,
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
    expect(
      shouldRenderConversationScreen({
        detail: { data: undefined, isError: false },
        routeSandboxId: 'sandbox-1',
      })
    ).toBe(false);
  });

  it('renders after conversation detail loads successfully', () => {
    expect(
      shouldRenderConversationScreen({
        detail: {
          data: {
            title: 'Kilo Chat',
            members: [
              { id: 'user-1', kind: 'user' },
              { id: 'bot:kiloclaw:sandbox-1', kind: 'bot' },
            ],
          },
          isError: false,
        },
        routeSandboxId: 'sandbox-1',
      })
    ).toBe(true);
  });
});

describe('getConversationRouteDecision', () => {
  it('rejects conversations that belong to a different sandbox route', () => {
    expect(
      getConversationRouteDecision({
        detail: {
          data: {
            title: 'Kilo Chat',
            members: [
              { id: 'user-1', kind: 'user' },
              { id: 'bot:kiloclaw:sandbox-b', kind: 'bot' },
            ],
          },
          isError: false,
        },
        routeSandboxId: 'sandbox-a',
      })
    ).toBe('not-found');
  });
});
