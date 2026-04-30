import { EventServiceClient } from '@kilocode/event-service';
import { KiloChatClient } from '@kilocode/kilo-chat';
import type * as KiloChatModule from '@kilocode/kilo-chat';
import { describe, expect, it, vi } from 'vitest';

import {
  useAddReaction,
  useDeleteMessage,
  useEditMessage,
  useExecuteAction,
  useRemoveReaction,
} from './use-messages';

const mocks = vi.hoisted(() => ({
  formatKiloChatError: vi.fn(() => 'formatted error'),
  toastError: vi.fn(),
  useAddReaction: vi.fn((..._args: unknown[]) => ({ kind: 'add-reaction' })),
  useDeleteMessage: vi.fn((..._args: unknown[]) => ({ kind: 'delete-message' })),
  useEditMessage: vi.fn((..._args: unknown[]) => ({ kind: 'edit-message' })),
  useExecuteAction: vi.fn((..._args: unknown[]) => ({ kind: 'execute-action' })),
  useRemoveReaction: vi.fn((..._args: unknown[]) => ({ kind: 'remove-reaction' })),
  useSendMessage: vi.fn((..._args: unknown[]) => ({ kind: 'send-message' })),
}));

vi.mock('@kilocode/kilo-chat', async importOriginal => ({
  ...(await importOriginal<typeof KiloChatModule>()),
  formatKiloChatError: mocks.formatKiloChatError,
}));

vi.mock('@kilocode/kilo-chat-hooks', () => ({
  useAddReaction: mocks.useAddReaction,
  useDeleteMessage: mocks.useDeleteMessage,
  useEditMessage: mocks.useEditMessage,
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

type ErrorOptions = { onError: (error: unknown) => void };

async function getToken() {
  await Promise.resolve();
  return 'token';
}

function isErrorHandler(value: unknown): value is (error: unknown) => void {
  return typeof value === 'function';
}

function expectErrorOptions(value: unknown): ErrorOptions {
  if (typeof value === 'object' && value !== null) {
    const onError = Reflect.get(value, 'onError');
    if (isErrorHandler(onError)) {
      return { onError };
    }
  }
  throw new Error('Expected mutation error options');
}

const eventService = new EventServiceClient({
  url: 'ws://localhost',
  getToken,
});
const client = new KiloChatClient({
  eventService,
  baseUrl: 'http://localhost',
  getToken,
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

  it('shows a toast when editing a message fails', () => {
    useEditMessage(client, 'conversation-1');
    const options = expectErrorOptions(mocks.useEditMessage.mock.calls[0]?.[2]);
    const error = new Error('network');

    options.onError(error);

    expect(mocks.formatKiloChatError).toHaveBeenCalledWith(error, 'Failed to edit message');
    expect(mocks.toastError).toHaveBeenCalledWith('formatted error');
  });

  it('shows a toast when deleting a message fails', () => {
    useDeleteMessage(client, 'conversation-1');
    const options = expectErrorOptions(mocks.useDeleteMessage.mock.calls[0]?.[2]);
    const error = new Error('network');

    options.onError(error);

    expect(mocks.formatKiloChatError).toHaveBeenCalledWith(error, 'Failed to delete message');
    expect(mocks.toastError).toHaveBeenCalledWith('formatted error');
  });
});
