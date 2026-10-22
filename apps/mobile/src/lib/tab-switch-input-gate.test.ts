import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  __resetTabSwitchInputForTests,
  isTabSwitchPending,
  markTabSwitchPending,
  scheduleTabSwitchSettle,
  settleTabSwitchInput,
  TAB_SWITCH_ACTIVE_TAB_SETTLE_MS,
  TAB_SWITCH_INPUT_FALLBACK_MS,
} from '@/lib/tab-switch-input-gate';

describe('tab switch input gate', () => {
  beforeEach(() => {
    __resetTabSwitchInputForTests();
    vi.useRealTimers();
  });

  it('stays open until a tab press arms it', () => {
    expect(isTabSwitchPending(1000)).toBe(false);

    markTabSwitchPending(1000);

    expect(isTabSwitchPending(1000)).toBe(true);
  });

  it('closes when the destination screen is on screen', () => {
    markTabSwitchPending(1000);

    settleTabSwitchInput();

    expect(isTabSwitchPending(1000)).toBe(false);
  });

  it('closes at the fallback so a switch that never lays out cannot swallow input', () => {
    markTabSwitchPending(1000);

    expect(isTabSwitchPending(1000 + TAB_SWITCH_INPUT_FALLBACK_MS - 1)).toBe(true);
    expect(isTabSwitchPending(1000 + TAB_SWITCH_INPUT_FALLBACK_MS)).toBe(false);
    expect(isTabSwitchPending(1000 + TAB_SWITCH_INPUT_FALLBACK_MS + 5000)).toBe(false);
  });

  it('restarts the window when another tab is pressed inside it', () => {
    markTabSwitchPending(1000);
    markTabSwitchPending(1500);

    expect(isTabSwitchPending(1500 + TAB_SWITCH_INPUT_FALLBACK_MS - 1)).toBe(true);
  });

  it('closes a press that opens no screen on its schedule', () => {
    vi.useFakeTimers();
    markTabSwitchPending();

    scheduleTabSwitchSettle(TAB_SWITCH_ACTIVE_TAB_SETTLE_MS);
    vi.advanceTimersByTime(TAB_SWITCH_ACTIVE_TAB_SETTLE_MS - 1);
    expect(isTabSwitchPending()).toBe(true);

    vi.advanceTimersByTime(1);
    expect(isTabSwitchPending()).toBe(false);
  });

  it('keeps the latest schedule when a press arrives first', () => {
    vi.useFakeTimers();
    scheduleTabSwitchSettle(TAB_SWITCH_ACTIVE_TAB_SETTLE_MS);
    markTabSwitchPending();

    vi.advanceTimersByTime(TAB_SWITCH_ACTIVE_TAB_SETTLE_MS);

    expect(isTabSwitchPending()).toBe(true);
  });
});
