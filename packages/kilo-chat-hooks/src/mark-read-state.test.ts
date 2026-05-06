import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  attemptMarkCurrentConversationRead,
  clearMarkReadRetry,
  createMarkReadRetryState,
  createMarkReadState,
  MARK_READ_RETRY_DELAY_MS,
  MARK_READ_RETRY_LIMIT,
  scheduleMarkReadRetry,
} from './mark-read-state';

describe('mark-read retry helpers', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('retries the same active marker after the first mark-read attempt rejects', async () => {
    const markReadState = createMarkReadState();
    const retryState = createMarkReadRetryState();
    const marker = 'conversation-1:message-1';
    let markReadAttemptCount = 0;

    const attempt = async () => {
      await attemptMarkCurrentConversationRead({
        marker,
        markReadState,
        retryState,
        currentMarker: () => marker,
        isActive: () => true,
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

  it('caps retries for a marker that keeps failing', () => {
    const retryState = createMarkReadRetryState();
    const retry = vi.fn();

    for (let attempt = 0; attempt < MARK_READ_RETRY_LIMIT + 1; attempt += 1) {
      scheduleMarkReadRetry(retryState, {
        marker: 'conversation-1:message-1',
        currentMarker: () => 'conversation-1:message-1',
        isActive: () => true,
        lastSucceededMarker: () => null,
        retry,
      });
      vi.advanceTimersByTime(MARK_READ_RETRY_DELAY_MS * (attempt + 1));
    }

    expect(retry).toHaveBeenCalledTimes(MARK_READ_RETRY_LIMIT);
    clearMarkReadRetry(retryState);
  });

  it('does not retry when the marker is stale or inactive', () => {
    const staleRetryState = createMarkReadRetryState();
    const inactiveRetryState = createMarkReadRetryState();
    const retry = vi.fn();

    scheduleMarkReadRetry(staleRetryState, {
      marker: 'conversation-1:message-1',
      currentMarker: () => 'conversation-1:message-2',
      isActive: () => true,
      lastSucceededMarker: () => null,
      retry,
    });
    scheduleMarkReadRetry(inactiveRetryState, {
      marker: 'conversation-1:message-1',
      currentMarker: () => 'conversation-1:message-1',
      isActive: () => false,
      lastSucceededMarker: () => null,
      retry,
    });

    vi.advanceTimersByTime(MARK_READ_RETRY_DELAY_MS);

    expect(retry).not.toHaveBeenCalled();
    clearMarkReadRetry(staleRetryState);
    clearMarkReadRetry(inactiveRetryState);
  });
});
