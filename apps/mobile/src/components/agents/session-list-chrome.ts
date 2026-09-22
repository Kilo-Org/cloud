import { useMemo } from 'react';

import { FAB_MARGIN, FAB_SIZE } from '@/components/agents/session-list-content';
import { useKeyboardOcclusion } from '@/components/kilo-chat/app-aware-keyboard-padding';

/** The FAB's own height plus its fixed margin above the tab bar. */
const FAB_BAND = FAB_SIZE + FAB_MARGIN;

/**
 * The Agents screen's bottom bands: the band the centered states reserve through
 * `StateSurfaceInsets` (`surfaceBand`) and the rows list's total band
 * (`listBand`), from which the rows frame's own band is derived.
 *
 * `surfaceBand` is that centered band in both keyboard positions — the IME's
 * occlusion while the keyboard is up, the tab bar's own height while it is down
 * — and never the FAB-inclusive band: the button's band rides the rows list's
 * own frame inset, and reserving it here as well shrank the centered band below
 * the tab bar's top edge on a short landscape window (landscape spot defect e8).
 * The screen passes the returned band to `StateSurfaceInsets` unchanged.
 *
 * Android's edge-to-edge window does not resize for the IME, so an empty state
 * that mounts while the search field's keyboard is already up draws its lower
 * lines — the no-match copy and its Clear search action — behind the keyboard
 * (explorer finding, agents-list). The hook mounts with the screen, so it
 * observes that keyboard before the body appears.
 *
 * The raised keyboard hides the tab bar (`tabBarHideOnKeyboard`), so the
 * keyboard's occlusion REPLACES the tab-bar band for the centered states instead
 * of the two stacking. Taking the larger of the two was the wrong rule: the
 * tab-bar band carries the bar's own height, which is not on screen while the
 * keyboard is up, and on a short landscape window that phantom band pushed the
 * centered copy's second line behind the keyboard (explorer finding,
 * agents-search-empty).
 *
 * The rows list must clear one overlay more. The FAB is not part of the tab bar
 * that hides: it keeps its screen-bottom-anchored position (`bottom:
 * tabBarHeight + FAB_MARGIN`) while the keyboard is up, so when the raised IME
 * is shorter than the button's own band the IME's occlusion alone parks the last
 * rows' right-aligned timestamps under the button with no way to scroll them
 * clear (device defect uxs1, e1-kbup.png). The list's band is therefore the
 * larger of the two, and the rows frame's own band (`rowsFrameBand`) is what is
 * left of it after the keyboard container's padding: the caller hands the frame
 * that remainder, so the frame and the container together end the viewport at
 * the band's edge instead of a whole IME height above it (review finding,
 * session-list-screen.tsx:418).
 */
export function useAgentsBottomBands(
  tabBarHeight: number,
  showFab: boolean
): { surfaceBand: number; rowsFrameBand: number } {
  const { keyboardOcclusion } = useKeyboardOcclusion();
  return useMemo(() => {
    const surfaceBand = keyboardOcclusion > 0 ? keyboardOcclusion : tabBarHeight;
    // The band the button's overlay covers from the screen bottom, `0` while the
    // button is not admitted.
    const fabBand = showFab ? tabBarHeight + FAB_BAND : 0;
    const listBand = Math.max(surfaceBand, fabBand);
    // The frame carries only the part of the total band the keyboard container
    // does not already cover: the container has moved the viewport's bottom
    // edge up by `keyboardOcclusion`. Deriving it here, beside the one
    // subscription that measures the occlusion, keeps the caller from adding a
    // second `useKeyboardOcclusion` of its own (review finding,
    // session-list-screen.tsx:101).
    return { surfaceBand, rowsFrameBand: Math.max(0, listBand - keyboardOcclusion) };
  }, [keyboardOcclusion, tabBarHeight, showFab]);
}

/**
 * The rows list's frame and content insets.
 *
 * The band shrinks the list's frame (`marginBottom`) so no row can scroll under
 * the button. It rides on the frame rather than the content: a content inset
 * only cleared the end of the list, so every row the user scrolled into the
 * button's band had its right-aligned timestamp and chevron covered, and a
 * scroll view's padding is not part of its scrollable content on iOS, so padding
 * on the frame clipped the last rows under the bar with no way to scroll them
 * clear. The band (`bottomBand`) is the caller's rows frame band
 * (`rowsFrameBand` from `useAgentsBottomBands`): the part of the rows list's
 * total band that the keyboard container does not already cover.
 * The centered states reserve `surfaceBand` instead. Android's edge-to-edge
 * window does not resize for the IME, so a keyboard-blind frame parked the last
 * rows of a search behind the keyboard with no way to scroll them clear (review
 * finding, session-list-chrome.ts). The landscape side insets keep row text
 * clear of the sensor housing; portrait insets are 0, keeping the geometry
 * unchanged.
 */
export function useSessionListInsets({
  bottomBand,
  left,
  right,
}: {
  bottomBand: number;
  left: number;
  right: number;
}) {
  return useMemo(
    () => ({
      frame: { marginBottom: bottomBand },
      content: { paddingTop: 0, paddingBottom: 0, paddingLeft: left, paddingRight: right },
    }),
    [bottomBand, left, right]
  );
}
