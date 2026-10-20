import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  __resetTabSwitchInputForTests,
  isTabSwitchPending,
  markTabSwitchPending,
  TAB_SWITCH_ACTIVE_TAB_SETTLE_MS,
} from '@/lib/tab-switch-input-gate';
import { tabPressListeners } from '@/lib/tab-press-listeners';

vi.mock('expo-haptics', () => ({ selectionAsync: vi.fn() }));

describe('tab press listeners', () => {
  beforeEach(() => {
    __resetTabSwitchInputForTests();
    vi.useFakeTimers();
  });

  it('settles the input window when the pressed tab is already focused', () => {
    markTabSwitchPending();

    tabPressListeners({ navigation: { isFocused: () => true } }).tabPress();
    vi.advanceTimersByTime(TAB_SWITCH_ACTIVE_TAB_SETTLE_MS);

    expect(isTabSwitchPending()).toBe(false);
  });

  it('leaves the window to the destination when another tab is pressed', () => {
    markTabSwitchPending();

    tabPressListeners({ navigation: { isFocused: () => false } }).tabPress();
    vi.advanceTimersByTime(TAB_SWITCH_ACTIVE_TAB_SETTLE_MS);

    expect(isTabSwitchPending()).toBe(true);
  });
});
