import { useMemo } from 'react';

import { FAB_MARGIN, FAB_SIZE } from '@/components/agents/session-list-content';
import { useKeyboardOcclusion } from '@/components/kilo-chat/app-aware-keyboard-padding';

/** The tab bar's own height, plus the FAB band when the button is admitted. */
function tabBarBand(tabBarHeight: number, showFab: boolean): number {
  return tabBarHeight + (showFab ? FAB_SIZE + FAB_MARGIN : 0);
}

/**
 * The bottom band the Agents list's centered states reserve: the tab-bar band
 * while the keyboard is down, or the raised keyboard's occlusion while it is up.
 *
 * Android's edge-to-edge window does not resize for the IME, so an empty state
 * that mounts while the search field's keyboard is already up draws its lower
 * lines — the no-match copy and its Clear search action — behind the keyboard
 * (explorer finding, agents-list). The hook mounts with the screen, so it
 * observes that keyboard before the body appears.
 *
 * The raised keyboard hides the tab bar (`tabBarHideOnKeyboard`), so the
 * keyboard's occlusion REPLACES the tab-bar band instead of the two stacking.
 * Taking the larger of the two was the wrong rule: the tab-bar band carries the
 * bar's own height, which is not on screen while the keyboard is up, and on a
 * short landscape window that phantom band pushed the centered copy's second
 * line behind the keyboard (explorer finding, agents-search-empty).
 */
export function useAgentsBottomBand(tabBarHeight: number, showFab: boolean): number {
  const { keyboardOcclusion } = useKeyboardOcclusion();
  if (keyboardOcclusion > 0) {
    return keyboardOcclusion;
  }
  return tabBarBand(tabBarHeight, showFab);
}

/**
 * The rows list's frame and content insets.
 *
 * The FAB band shrinks the list's frame (`marginBottom`) so no row can scroll
 * under the button. It rides on the frame rather than the content: a content
 * inset only cleared the end of the list, so every row the user scrolled into
 * the button's band had its right-aligned timestamp and chevron covered, and a
 * scroll view's padding is not part of its scrollable content on iOS, so padding
 * on the frame clipped the last rows under the bar with no way to scroll them
 * clear. The vertical value matches the screen's `StateSurfaceInsets`. The
 * landscape side insets keep row text clear of the sensor housing; portrait
 * insets are 0, keeping the geometry unchanged.
 */
export function useSessionListInsets({
  tabBarHeight,
  showFab,
  left,
  right,
}: {
  tabBarHeight: number;
  showFab: boolean;
  left: number;
  right: number;
}) {
  return useMemo(
    () => ({
      frame: { marginBottom: tabBarBand(tabBarHeight, showFab) },
      content: { paddingTop: 0, paddingBottom: 0, paddingLeft: left, paddingRight: right },
    }),
    [showFab, tabBarHeight, left, right]
  );
}
