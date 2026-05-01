import {
  MARK_READ_RETRY_DELAY_MS,
  MARK_READ_RETRY_LIMIT,
  createMarkReadRetryState,
  scheduleMarkReadRetry,
} from './message-area-mark-read-retry';

describe('scheduleMarkReadRetry', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('retries the same visible marker after a failed mark-read attempt settles', () => {
    const retryState = createMarkReadRetryState();
    const retry = jest.fn();

    scheduleMarkReadRetry(retryState, {
      marker: 'conv-1:msg-1',
      currentMarker: () => 'conv-1:msg-1',
      isVisible: () => true,
      lastSucceededMarker: () => null,
      retry,
    });

    expect(retry).not.toHaveBeenCalled();

    jest.advanceTimersByTime(MARK_READ_RETRY_DELAY_MS);

    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('caps retries for a marker that keeps failing', () => {
    const retryState = createMarkReadRetryState();
    const retry = jest.fn();

    for (let i = 0; i < MARK_READ_RETRY_LIMIT + 1; i++) {
      scheduleMarkReadRetry(retryState, {
        marker: 'conv-1:msg-1',
        currentMarker: () => 'conv-1:msg-1',
        isVisible: () => true,
        lastSucceededMarker: () => null,
        retry,
      });
      jest.advanceTimersByTime(MARK_READ_RETRY_DELAY_MS * (i + 1));
    }

    expect(retry).toHaveBeenCalledTimes(MARK_READ_RETRY_LIMIT);
  });
});
