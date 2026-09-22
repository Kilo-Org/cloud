import { useCallback, useMemo, useState } from 'react';
import { type LayoutChangeEvent } from 'react-native';

import { FAB_MARGIN, FAB_SIZE } from '@/components/agents/session-list-content';
import { getAgentsListBottomInset } from '@/lib/agents-bottom-chrome';

type AgentsListChromeInput = {
  tabBarHeight: number;
  showFab: boolean;
  left: number;
  right: number;
};

/**
 * The live list's bottom chrome: the measured body height, its `onLayout`
 * handler, and the list insets / FAB style / side padding derived from them.
 * Split out of the screen because the screen sits at the 300-line lint budget
 * once comments are skipped.
 */
export function useAgentsListChrome({ tabBarHeight, showFab, left, right }: AgentsListChromeInput) {
  const [bodyHeight, setBodyHeight] = useState<number | null>(null);
  const onBodyLayout = useCallback((event: LayoutChangeEvent) => {
    setBodyHeight(Math.round(event.nativeEvent.layout.height));
  }, []);

  // The tab bar and the FAB are absolutely-positioned overlays, so scrollable
  // content must clear them. The hard part of the band rides on the list's
  // frame as a `marginBottom` (the viewport ends above it) — the same viewport
  // inset `TabScreenScrollView` uses — and never as `style` padding: a scroll
  // view's padding is not part of its scrollable content on iOS, so padding on
  // the frame clipped the last rows under the bar with no way to scroll them
  // clear. In a short window the FAB band is soft and yields as far as one row
  // pitch needs (see `getAgentsListBottomInset`); that yielded part rides on
  // the list's *content* (`paddingBottom`) so the last row can still be
  // scrolled clear of the button, while a content inset for the whole band
  // would have let every scrolled row park under the button's timestamp and
  // chevron (device defect uxs1). The vertical value matches the screen's
  // `StateSurfaceInsets`. The landscape side insets keep row text clear of the
  // sensor housing; portrait insets are 0, keeping the geometry unchanged.
  const listInsets = useMemo(() => {
    const { frame, content } = getAgentsListBottomInset({
      available: bodyHeight,
      tabBarHeight,
      fabBand: showFab ? FAB_SIZE + FAB_MARGIN : 0,
    });
    return {
      frame: { marginBottom: frame },
      content: { paddingTop: 0, paddingBottom: content, paddingLeft: left, paddingRight: right },
    };
  }, [bodyHeight, showFab, tabBarHeight, left, right]);

  // The fixed 20pt margin gains the landscape right inset so the FAB clears the
  // sensor area; portrait insets are 0, keeping the geometry unchanged.
  const fabStyle = useMemo(
    () => ({
      bottom: tabBarHeight + FAB_MARGIN,
      right: 20 + right,
      width: FAB_SIZE,
      height: FAB_SIZE,
    }),
    [tabBarHeight, right]
  );

  // The fixed 22px margins on the skeleton rows and the status wrapper gain
  // the landscape side insets so they clear the sensor housing too; portrait
  // insets are 0, keeping the geometry unchanged.
  const sidePadding = useMemo(
    () => ({ paddingLeft: 22 + left, paddingRight: 22 + right }),
    [left, right]
  );

  return { bodyHeight, onBodyLayout, listInsets, fabStyle, sidePadding };
}
