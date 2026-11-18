import { selectionHaptic } from '@/lib/haptics';

import {
  planProfileTabPress,
  type PressedTabRoute,
  type TabPressNavigation,
} from '@/lib/tab-press';
import {
  markTabSwitchPending,
  scheduleTabSwitchSettle,
  TAB_SWITCH_ACTIVE_TAB_SETTLE_MS,
} from '@/lib/tab-switch-input-gate';

/** The part of the tab's navigation the press listeners read. */
type TabFocus = { isFocused: () => boolean };
type TabPressEvent = { preventDefault: () => void };

/**
 * A press on the tab that is already focused opens no screen, so its input
 * window settles on its own timer instead of waiting for a layout that never
 * comes; the pop back to that tab's root still has time to land. The focused
 * scene stays focused for such a press, so the window is armed as a same-tab
 * one: the claim then rests on the timer rather than on the scene's focus.
 */
function settleFocusedTabPress(navigation: TabFocus): void {
  if (navigation.isFocused()) {
    markTabSwitchPending(Date.now(), { sameTab: true });
    scheduleTabSwitchSettle(TAB_SWITCH_ACTIVE_TAB_SETTLE_MS);
  }
}

/**
 * The press selects its own tab through the navigation queue, and leaves the
 * bar's own press handling in place beside it.
 *
 * The navigator moves the tab only when its bar does not already consider the
 * pressed entry focused, and the bar reads that from the last render. A burst of
 * presses outruns those renders: the queue applies each press to the latest
 * route state while the bar still renders an earlier one, so the bar can see the
 * pressed tab as focused and drop a press that is a real move — eight rapid taps
 * ending on Profile left Chat selected that way (explorer finding
 * `xmvveh9nv34`). `JUMP_TO` is the tab router's "focus this tab": dispatched
 * here it reaches the same route state the earlier presses reached, so the last
 * tab tapped wins, and for the tab that is already focused it changes nothing,
 * which keeps a re-press — and the navigator's pop to that tab's root for it —
 * exactly as it was. The default press is not prevented, so the navigator, the
 * focused tab's automatic pop to its root and the Profile re-press plan below
 * all still run.
 */
function selectPressedTab(navigation: TabPressNavigation, route: PressedTabRoute): void {
  navigation.dispatch({
    type: 'JUMP_TO',
    payload: { name: route.name, params: route.params },
  });
}

/** The plain tab press: the same feedback for every tab without its own move. */
export function tabPressListeners({
  navigation,
  route,
}: {
  navigation: TabFocus & TabPressNavigation;
  route: PressedTabRoute;
}) {
  return {
    tabPress: () => {
      selectPressedTab(navigation, route);
      settleFocusedTabPress(navigation);
      selectionHaptic();
    },
  };
}

/**
 * The Profile entry: feedback, then the profile tab's press plan
 * (`planProfileTabPress`). A cross-tab press and a form-sheet re-press are left
 * to the navigator, which keeps the tab's stack and sheet. Only the re-press
 * that moves the tab to its root is ours — a pop, so the shared
 * unsaved-changes guard can intercept and replay it.
 */
export function profileTabPressListeners(segments: readonly string[]) {
  return ({
    navigation,
    route,
  }: {
    navigation: TabFocus & TabPressNavigation;
    route: PressedTabRoute;
  }) => ({
    tabPress: (event: TabPressEvent) => {
      selectPressedTab(navigation, route);
      settleFocusedTabPress(navigation);
      selectionHaptic();
      const profileStack = navigation
        .getState()
        ?.routes.find(tabRoute => tabRoute.name === '(3_profile)')?.state;
      // The typed route union does not carry the tab group for every route; the
      // check is a plain segment membership test.
      const plan = planProfileTabPress({
        profileFocused: segments.includes('(3_profile)'),
        segments,
        profileStackIndex: profileStack?.index,
      });
      if (plan !== 'reset-to-root') {
        return;
      }
      event.preventDefault();
      if (profileStack?.key) {
        navigation.dispatch({ type: 'POP_TO_TOP', target: profileStack.key });
      }
    },
  });
}
