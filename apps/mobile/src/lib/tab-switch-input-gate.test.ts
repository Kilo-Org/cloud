import { beforeEach, describe, expect, it } from 'vitest';

import {
  __resetTabSwitchInputForTests,
  isTabSwitchPending,
  markTabSwitchPending,
  settleTabSwitchInput,
  TAB_SWITCH_INPUT_FALLBACK_MS,
} from '@/lib/tab-switch-input-gate';

describe('tab switch input gate', () => {
  beforeEach(() => {
    __resetTabSwitchInputForTests();
  });

  it('stays open until a tab press arms it', () => {
    expect(isTabSwitchPending(1000)).toBe(false);

    markTabSwitchPending(1000);

    expect(isTabSwitchPending(1000)).toBe(true);
  });

  it('closes when the destination route commits', () => {
    markTabSwitchPending(1000);

    settleTabSwitchInput();

    expect(isTabSwitchPending(1000)).toBe(false);
  });

  it('closes at the fallback so a switch that never commits cannot swallow input', () => {
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
});
