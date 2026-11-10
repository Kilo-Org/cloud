import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  __resetTabSwitchInputForTests,
  isTabSwitchPending,
  markTabSwitchPending,
  TAB_SWITCH_ACTIVE_TAB_SETTLE_MS,
} from '@/lib/tab-switch-input-gate';
import { profileTabPressListeners, tabPressListeners } from '@/lib/tab-press-listeners';
import { type TabPressAction } from '@/lib/tab-press';

vi.mock('expo-haptics', () => ({ selectionAsync: vi.fn() }));

const HOME_ROUTE = { name: '(0_home)' };
const PROFILE_ROUTE = { name: '(3_profile)' };

function navigationDouble({ focused }: Readonly<{ focused: boolean }>) {
  return {
    isFocused: () => focused,
    getState: () => ({
      routes: [{ name: '(3_profile)', state: { key: 'profile-stack', index: 0 } }],
    }),
    dispatch: vi.fn<(action: TabPressAction) => void>(),
  };
}

describe('tab press listeners', () => {
  beforeEach(() => {
    __resetTabSwitchInputForTests();
    vi.useFakeTimers();
  });

  it('settles the input window when the pressed tab is already focused', () => {
    markTabSwitchPending();

    tabPressListeners({
      navigation: navigationDouble({ focused: true }),
      route: HOME_ROUTE,
    }).tabPress();
    vi.advanceTimersByTime(TAB_SWITCH_ACTIVE_TAB_SETTLE_MS);

    expect(isTabSwitchPending()).toBe(false);
  });

  it('leaves the window to the destination when another tab is pressed', () => {
    markTabSwitchPending();

    tabPressListeners({
      navigation: navigationDouble({ focused: false }),
      route: HOME_ROUTE,
    }).tabPress();
    vi.advanceTimersByTime(TAB_SWITCH_ACTIVE_TAB_SETTLE_MS);

    expect(isTabSwitchPending()).toBe(true);
  });

  it('selects the pressed tab even when the bar still renders it as focused', () => {
    const navigation = navigationDouble({ focused: true });

    tabPressListeners({ navigation, route: HOME_ROUTE }).tabPress();

    expect(navigation.dispatch).toHaveBeenCalledWith({
      type: 'JUMP_TO',
      payload: { name: '(0_home)', params: undefined },
    });
  });

  it('keeps the route params the pressed tab already carries', () => {
    const navigation = navigationDouble({ focused: false });
    const params = { scope: 'personal' };

    tabPressListeners({ navigation, route: { name: '(2_agents)', params } }).tabPress();

    expect(navigation.dispatch).toHaveBeenCalledWith({
      type: 'JUMP_TO',
      payload: { name: '(2_agents)', params },
    });
  });

  it('settles the input window when the focused profile tab is pressed', () => {
    markTabSwitchPending();
    const navigation = navigationDouble({ focused: true });

    profileTabPressListeners(['(app)', '(tabs)', '(3_profile)'])({
      navigation,
      route: PROFILE_ROUTE,
    }).tabPress({ preventDefault: vi.fn<() => void>() });
    vi.advanceTimersByTime(TAB_SWITCH_ACTIVE_TAB_SETTLE_MS);

    expect(isTabSwitchPending()).toBe(false);
    expect(navigation.dispatch).toHaveBeenCalledWith({
      type: 'JUMP_TO',
      payload: { name: '(3_profile)', params: undefined },
    });
  });
});
