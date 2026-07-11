import { KiloChatApiError } from '@kilocode/kilo-chat';
import { describe, expect, it } from 'vitest';

import {
  getConversationRouteDecision,
  getConversationRouteErrorMessage,
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

describe('getConversationRouteDecision', () => {
  it('is pending while the conversation detail is loading', () => {
    expect(
      getConversationRouteDecision({
        detail: { data: undefined, error: undefined, isError: false },
        routeSandboxId: 'sandbox-1',
      })
    ).toBe('pending');
  });

  it('is ready after conversation detail loads successfully', () => {
    expect(
      getConversationRouteDecision({
        detail: {
          data: {
            title: 'Kilo Chat',
            members: [
              { id: 'user-1', kind: 'user' },
              { id: 'bot:kiloclaw:sandbox-1', kind: 'bot' },
            ],
          },
          error: undefined,
          isError: false,
        },
        routeSandboxId: 'sandbox-1',
      })
    ).toBe('ready');
  });

  it('stays ready when a background refetch fails but cached data is retained', () => {
    expect(
      getConversationRouteDecision({
        detail: {
          data: {
            title: 'Kilo Chat',
            members: [
              { id: 'user-1', kind: 'user' },
              { id: 'bot:kiloclaw:sandbox-1', kind: 'bot' },
            ],
          },
          error: new Error('network down'),
          isError: true,
        },
        routeSandboxId: 'sandbox-1',
      })
    ).toBe('ready');
  });

  it('redirects even with cached data when the background refetch confirms not-found/forbidden', () => {
    expect(
      getConversationRouteDecision({
        detail: {
          data: {
            title: 'Kilo Chat',
            members: [
              { id: 'user-1', kind: 'user' },
              { id: 'bot:kiloclaw:sandbox-1', kind: 'bot' },
            ],
          },
          error: new KiloChatApiError(403, {}),
          isError: true,
        },
        routeSandboxId: 'sandbox-1',
      })
    ).toBe('not-found');
  });
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
          error: undefined,
          isError: false,
        },
        routeSandboxId: 'sandbox-a',
      })
    ).toBe('not-found');
  });

  it('redirects (not-found) for a confirmed forbidden/not-found API error', () => {
    expect(
      getConversationRouteDecision({
        detail: { data: undefined, error: new KiloChatApiError(404, {}), isError: true },
        routeSandboxId: 'sandbox-1',
      })
    ).toBe('not-found');
  });

  it('surfaces a retryable error in place for transport/server failures', () => {
    expect(
      getConversationRouteDecision({
        detail: { data: undefined, error: new Error('network down'), isError: true },
        routeSandboxId: 'sandbox-1',
      })
    ).toBe('retryable-error');

    expect(
      getConversationRouteDecision({
        detail: { data: undefined, error: new KiloChatApiError(500, {}), isError: true },
        routeSandboxId: 'sandbox-1',
      })
    ).toBe('retryable-error');
  });
});
