import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createMessageListKeyboardScrollScheduler,
  createMessageListNewestScrollScheduler,
  MESSAGE_LIST_KEYBOARD_SCROLL_RETRY_DELAY_MS,
} from './message-list-keyboard-scroll';

describe('message list keyboard scroll scheduler', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('maintains the current viewport by shifting the offset by keyboard height', () => {
    vi.useFakeTimers();
    const calls: { animated: boolean; offset: number }[] = [];
    const scheduler = createMessageListKeyboardScrollScheduler({
      getScrollOffset: () => 240,
      scrollToOffset: params => {
        calls.push(params);
      },
    });

    scheduler.schedule(320);

    expect(calls).toEqual([{ animated: true, offset: 560 }]);

    vi.advanceTimersByTime(MESSAGE_LIST_KEYBOARD_SCROLL_RETRY_DELAY_MS);

    expect(calls).toEqual([
      { animated: true, offset: 560 },
      { animated: true, offset: 560 },
    ]);
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

    vi.advanceTimersByTime(MESSAGE_LIST_KEYBOARD_SCROLL_RETRY_DELAY_MS);

    expect(calls).toEqual([{ animated: true }, { animated: true }]);
  });
});
