import { useMemo } from 'react';

import { FAB_MARGIN, FAB_SIZE } from '@/components/agents/session-list-content';

/** The FAB's own height plus its fixed margin above the tab bar. */
const FAB_BAND = FAB_SIZE + FAB_MARGIN;

/**
 * Fixed overlay clearance left after the native keyboard container resizes the
 * body by `keyboardOcclusion`, the screen's own keyboard height.
 */
export function useAgentsBottomBands(
  tabBarHeight: number,
  showFab: boolean,
  keyboardOcclusion: number
): { surfaceBand: number; rowsFrameBand: number } {
  return useMemo(() => {
    const surfaceBand = keyboardOcclusion > 0 ? keyboardOcclusion : tabBarHeight;
    // The band the button's overlay covers from the screen bottom, `0` while the
    // button is not admitted.
    const fabBand = showFab ? tabBarHeight + FAB_BAND : 0;
    const listBand = Math.max(surfaceBand, fabBand);
    // The frame carries only the part of the total band the keyboard container
    // does not already cover: the container has moved the viewport's bottom
    // edge up by `keyboardOcclusion`.
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
