import * as Haptics from 'expo-haptics';

import { planProfileTabPress, type TabPressNavigation } from '@/lib/tab-press';
import {
  scheduleTabSwitchSettle,
  TAB_SWITCH_ACTIVE_TAB_SETTLE_MS,
} from '@/lib/tab-switch-input-gate';

/** The part of the tab's navigation the press listeners read. */
type TabFocus = { isFocused: () => boolean };
type TabPressEvent = { preventDefault: () => void };

/**
 * A press on the tab that is already focused opens no screen, so its input
 * window settles on its own timer instead of waiting for a layout that never
 * comes; the pop back to that tab's root still has time to land.
 */
function settleFocusedTabPress(navigation: TabFocus): void {
  if (navigation.isFocused()) {
    scheduleTabSwitchSettle(TAB_SWITCH_ACTIVE_TAB_SETTLE_MS);
  }
}

/** The plain tab press: the same feedback for every tab without its own move. */
export function tabPressListeners({ navigation }: { navigation: TabFocus }) {
  return {
    tabPress: () => {
      settleFocusedTabPress(navigation);
      void Haptics.selectionAsync();
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
  return ({ navigation }: { navigation: TabFocus & TabPressNavigation }) => ({
    tabPress: (event: TabPressEvent) => {
      settleFocusedTabPress(navigation);
      void Haptics.selectionAsync();
      const profileStack = navigation
        .getState()
        ?.routes.find(route => route.name === '(3_profile)')?.state;
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
