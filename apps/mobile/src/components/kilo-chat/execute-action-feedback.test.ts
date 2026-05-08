import { QueryClient } from '@tanstack/react-query';
import { type Message } from '@kilocode/kilo-chat';
import {
  type MessageInfiniteData,
  messagesKey,
  restoreMessageInCache,
} from '@kilocode/kilo-chat-hooks';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { toast } from 'sonner-native';

import { executeActionWithMobileFeedback } from './execute-action-feedback';

vi.mock('sonner-native', () => ({
  toast: {
    error: vi.fn(),
  },
}));

function actionMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: 'message-1',
    senderId: 'bot:sandbox-1',
    content: [
      {
        type: 'actions',
        groupId: 'approval-1',
        actions: [{ label: 'Allow once', style: 'primary', value: 'allow-once' }],
      },
    ],
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

describe('executeActionWithMobileFeedback', () => {
  beforeEach(() => {
    vi.mocked(toast.error).mockClear();
  });

  it('shows a toast when the execute-action mutation reports an error', () => {
    const mutate = vi.fn((_variables, options?: { onError?: (err: unknown) => void }) => {
      options?.onError?.(new Error('offline'));
    });

    executeActionWithMobileFeedback({
      executeAction: { mutate },
      message: actionMessage(),
      groupId: 'approval-1',
      value: 'allow-once',
    });

    expect(mutate).toHaveBeenCalledWith(
      { messageId: 'message-1', groupId: 'approval-1', value: 'allow-once' },
      { onError: expect.any(Function) }
    );
    expect(toast.error).toHaveBeenCalledWith('Failed to execute action');
  });

  it('restores an optimistically resolved action when shared rollback runs', () => {
    const queryClient = new QueryClient();
    const queryKey = messagesKey('conversation-1');
    const original = actionMessage();
    const optimistic = actionMessage({
      content: [
        {
          type: 'actions',
          groupId: 'approval-1',
          actions: [{ label: 'Allow once', style: 'primary', value: 'allow-once' }],
          resolved: {
            value: 'allow-once',
            resolvedBy: 'user-1',
            resolvedAt: 1,
          },
        },
      ],
    });
    queryClient.setQueryData<MessageInfiniteData>(queryKey, {
      pages: [{ messages: [optimistic], hasMore: false, nextCursor: null }],
      pageParams: [undefined],
    });

    restoreMessageInCache(queryClient, queryKey, original);

    const result = queryClient.getQueryData<MessageInfiniteData>(queryKey);
    expect(result?.pages[0]?.messages[0]).toEqual(original);
  });
});
