import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createMarkReadState } from '@kilocode/kilo-chat-hooks';
import {
  attemptMarkCurrentConversationRead,
  clearMarkReadRetry,
  createMarkReadRetryState,
  MARK_READ_RETRY_DELAY_MS,
  MARK_READ_RETRY_LIMIT,
  scheduleMarkReadRetry,
} from './conversation-mark-read';

describe('attemptMarkCurrentConversationRead', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('retries the same focused latest message after the first mark-read attempt rejects', async () => {
    const markReadState = createMarkReadState();
    const retryState = createMarkReadRetryState();
    const marker = 'conversation-1:message-1';
    let markReadAttemptCount = 0;

    const attempt = async () => {
      await attemptMarkCurrentConversationRead({
        marker,
        markReadState,
        retryState,
        activeAndFocused: () => true,
        currentMarker: () => marker,
        markRead: async () => {
          await Promise.resolve();
          markReadAttemptCount += 1;
          if (markReadAttemptCount === 1) {
            throw new Error('mark read failed');
          }
        },
        retry: () => {
          void attempt();
        },
      });
    };

    await attempt();
    expect(markReadAttemptCount).toBe(1);

    await vi.advanceTimersByTimeAsync(MARK_READ_RETRY_DELAY_MS);

    expect(markReadAttemptCount).toBe(2);
    clearMarkReadRetry(retryState);
  });

  it('does not retry a marker after the retry limit is reached', () => {
    const retryState = createMarkReadRetryState();
    const retry = vi.fn();

    for (let i = 0; i < MARK_READ_RETRY_LIMIT + 1; i += 1) {
      scheduleMarkReadRetry(retryState, {
        marker: 'conversation-1:message-1',
        currentMarker: () => 'conversation-1:message-1',
        activeAndFocused: () => true,
        lastSucceededMarker: () => null,
        retry: () => {
          retry();
        },
      });
      vi.advanceTimersByTime(MARK_READ_RETRY_DELAY_MS * (i + 1));
    }

    expect(retry).toHaveBeenCalledTimes(MARK_READ_RETRY_LIMIT);
    clearMarkReadRetry(retryState);
  });

  it('does not retry when the marker is stale or the screen is inactive', () => {
    const staleRetryState = createMarkReadRetryState();
    const inactiveRetryState = createMarkReadRetryState();
    const retry = vi.fn();

    scheduleMarkReadRetry(staleRetryState, {
      marker: 'conversation-1:message-1',
      currentMarker: () => 'conversation-1:message-2',
      activeAndFocused: () => true,
      lastSucceededMarker: () => null,
      retry: () => {
        retry();
      },
    });
    scheduleMarkReadRetry(inactiveRetryState, {
      marker: 'conversation-1:message-1',
      currentMarker: () => 'conversation-1:message-1',
      activeAndFocused: () => false,
      lastSucceededMarker: () => null,
      retry: () => {
        retry();
      },
    });

    vi.advanceTimersByTime(MARK_READ_RETRY_DELAY_MS);

    expect(retry).not.toHaveBeenCalled();
    clearMarkReadRetry(staleRetryState);
    clearMarkReadRetry(inactiveRetryState);
  });
});
