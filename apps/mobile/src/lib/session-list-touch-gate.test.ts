import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  __resetSessionListTouchGateForTests,
  holdSessionListTouch,
  isSessionListTouchHeld,
  SESSION_LIST_TOUCH_SETTLE_MS,
} from './session-list-touch-gate';

describe('session list touch gate', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    __resetSessionListTouchGateForTests();
  });

  afterEach(() => {
    vi.useRealTimers();
    __resetSessionListTouchGateForTests();
  });

  it('lets a touch through while no clear action is settling', () => {
    expect(isSessionListTouchHeld()).toBe(false);
  });

  it('keeps a touch off the list for the whole settle window, then opens', () => {
    holdSessionListTouch();

    expect(isSessionListTouchHeld()).toBe(true);
    vi.advanceTimersByTime(SESSION_LIST_TOUCH_SETTLE_MS - 1);
    expect(isSessionListTouchHeld()).toBe(true);
    vi.advanceTimersByTime(1);
    expect(isSessionListTouchHeld()).toBe(false);
  });

  it('keeps the gate shut until the last of two overlapping clears expires', () => {
    holdSessionListTouch(SESSION_LIST_TOUCH_SETTLE_MS);
    vi.advanceTimersByTime(SESSION_LIST_TOUCH_SETTLE_MS / 2);
    holdSessionListTouch(SESSION_LIST_TOUCH_SETTLE_MS);

    vi.advanceTimersByTime(SESSION_LIST_TOUCH_SETTLE_MS / 2);
    expect(isSessionListTouchHeld()).toBe(true);
    vi.advanceTimersByTime(SESSION_LIST_TOUCH_SETTLE_MS / 2);
    expect(isSessionListTouchHeld()).toBe(false);
  });

  it('opens at the returned release without waiting out the window', () => {
    const release = holdSessionListTouch();

    release();
    release();
    expect(isSessionListTouchHeld()).toBe(false);
  });

  it('clears an armed hold and its timer on the test reset', () => {
    holdSessionListTouch();
    expect(vi.getTimerCount()).toBe(1);

    __resetSessionListTouchGateForTests();

    expect(isSessionListTouchHeld()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
});
