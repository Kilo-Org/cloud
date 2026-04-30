import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  formatKiloChatError: vi.fn(() => 'formatted error'),
  toastError: vi.fn(),
  useAddReaction: vi.fn((..._args: unknown[]) => ({ kind: 'add-reaction' })),
  useExecuteAction: vi.fn((..._args: unknown[]) => ({ kind: 'execute-action' })),
  useRemoveReaction: vi.fn((..._args: unknown[]) => ({ kind: 'remove-reaction' })),
  useSendMessage: vi.fn((..._args: unknown[]) => ({ kind: 'send-message' })),
}));

vi.mock('@kilocode/kilo-chat', async importOriginal => ({
  ...(await importOriginal<typeof import('@kilocode/kilo-chat')>()),
  formatKiloChatError: mocks.formatKiloChatError,
}));

vi.mock('@kilocode/kilo-chat-hooks', () => ({
  useAddReaction: mocks.useAddReaction,
  useExecuteAction: mocks.useExecuteAction,
  useMessageCacheUpdater: vi.fn(),
  useMessages: vi.fn(),
  useRemoveReaction: mocks.useRemoveReaction,
  useSendMessage: mocks.useSendMessage,
}));

vi.mock('sonner-native', () => ({
  toast: {
    error: mocks.toastError,
  },
}));

import { useAddReaction, useExecuteAction, useRemoveReaction } from './use-messages';
import { EventServiceClient } from '@kilocode/event-service';
import { KiloChatClient } from '@kilocode/kilo-chat';

type ErrorOptions = { onError: (error: unknown) => void };

function expectErrorOptions(value: unknown): ErrorOptions {
  if (typeof value === 'object' && value !== null) {
    const onError = Reflect.get(value, 'onError');
    if (typeof onError === 'function') {
      return {
        onError: error => {
          onError(error);
        },
      };
    }
  }
  throw new Error('Expected mutation error options');
}

const eventService = new EventServiceClient({
  url: 'ws://localhost',
  getToken: () => Promise.resolve('token'),
});
const client = new KiloChatClient({
  eventService,
  baseUrl: 'http://localhost',
  getToken: () => Promise.resolve('token'),
});

describe('mobile kilo-chat message mutation wrappers', () => {
  it('shows a toast when adding a reaction fails', () => {
    useAddReaction(client, 'conversation-1', 'user-1');
    const options = expectErrorOptions(mocks.useAddReaction.mock.calls[0]?.[3]);
    const error = new Error('network');

    options.onError(error);

    expect(mocks.formatKiloChatError).toHaveBeenCalledWith(error, 'Failed to add reaction');
    expect(mocks.toastError).toHaveBeenCalledWith('formatted error');
  });

  it('shows a toast when removing a reaction fails', () => {
    useRemoveReaction(client, 'conversation-1', 'user-1');
    const options = expectErrorOptions(mocks.useRemoveReaction.mock.calls[0]?.[3]);
    const error = new Error('network');

    options.onError(error);

    expect(mocks.formatKiloChatError).toHaveBeenCalledWith(error, 'Failed to remove reaction');
    expect(mocks.toastError).toHaveBeenCalledWith('formatted error');
  });

  it('shows a toast when executing an action fails', () => {
    useExecuteAction(client, 'conversation-1', 'user-1');
    const options = expectErrorOptions(mocks.useExecuteAction.mock.calls[0]?.[3]);
    const error = new Error('network');

    options.onError(error);

    expect(mocks.formatKiloChatError).toHaveBeenCalledWith(error, 'Failed to execute action');
    expect(mocks.toastError).toHaveBeenCalledWith('formatted error');
  });
});
