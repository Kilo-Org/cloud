import * as Haptics from 'expo-haptics';
import { type Href } from 'expo-router';

import { PROFILE_TAB_ROOT } from '@/lib/finding-detail-back';
import {
  scheduleTabSwitchSettle,
  TAB_SWITCH_ACTIVE_TAB_SETTLE_MS,
} from '@/lib/tab-switch-input-gate';

/** The part of the tab's navigation the press listeners read. */
type TabFocus = { isFocused: () => boolean };
type TabPressEvent = { preventDefault: () => void };
type TabRouter = { navigate: (href: Href) => void };

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

/** The Profile entry: feedback, then back to the tab's root. */
export function profileTabPressListeners(router: TabRouter) {
  return ({ navigation }: { navigation: TabFocus }) => ({
    tabPress: (event: TabPressEvent) => {
      settleFocusedTabPress(navigation);
      void Haptics.selectionAsync();
      event.preventDefault();
      router.navigate(PROFILE_TAB_ROOT);
    },
  });
}
