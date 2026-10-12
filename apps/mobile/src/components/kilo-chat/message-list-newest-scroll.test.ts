import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createMessageListNewestScrollScheduler,
  MESSAGE_LIST_NEWEST_SCROLL_RETRY_DELAY_MS,
} from './message-list-newest-scroll';

describe('message list newest scroll scheduler', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('scrolls to the newest message immediately and after layout settles', () => {
    vi.useFakeTimers();
    const calls: { animated: boolean }[] = [];
    const scheduler = createMessageListNewestScrollScheduler({
      scrollToEnd: params => {
        calls.push(params);
      },
    });

    scheduler.schedule();

    expect(calls).toEqual([{ animated: true }]);

    vi.advanceTimersByTime(MESSAGE_LIST_NEWEST_SCROLL_RETRY_DELAY_MS);

    expect(calls).toEqual([{ animated: true }, { animated: true }]);
  });
});
