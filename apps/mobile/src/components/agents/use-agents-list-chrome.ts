import { useCallback, useMemo, useState } from 'react';
import { type LayoutChangeEvent } from 'react-native';

import { FAB_MARGIN, FAB_SIZE } from '@/components/agents/session-list-content';
import { REFRESH_PROGRESS_REDUCED_MOTION_HEIGHT } from '@/components/ui/refresh-progress';
import { useProvidedMotionPolicy } from '@/lib/a11y/motion-context';
import { getEmptyStatePresentation } from '@/lib/agents-bottom-chrome';

/**
 * Bottom-chrome geometry for the Agents live list: the measurement the empty
 * states' presentation decision reads and the reserve the screen's centered
 * states clear.
 *
 * The body wrapper is a `flex-1` child of the screen's column, so its height
 * does not depend on the reserve the list carries (no measure loop). `null`
 * until the first layout keeps the pre-measurement reserve.
 */
export function useAgentsListChrome({
  showFab,
  tabBarHeight,
  fontScale,
  left,
  right,
}: {
  showFab: boolean;
  tabBarHeight: number;
  fontScale: number;
  left: number;
  right: number;
}) {
  const [bodyHeight, setBodyHeight] = useState<number | null>(null);
  const onBodyLayout = useCallback((event: LayoutChangeEvent) => {
    setBodyHeight(Math.round(event.nativeEvent.layout.height));
  }, []);

  // The FAB band is soft chrome: the list's frame yields it in a short window,
  // and the centered states reserve it while the button shows, so a full-width
  // action (the load failure's Retry, the boundary's back-to-profile) cannot
  // run under the corner overlay.
  const fabBand = showFab ? FAB_SIZE + FAB_MARGIN : 0;
  const centeredBottomInset = tabBarHeight + fabBand;
  // `CenteredState` publishes the band above the pull-to-refresh line it renders
  // above the children, and under reduced motion that line reserves its `h-9`
  // box whether or not a pull is in flight (`RefreshProgress`). The decision
  // must read the same band, or a reduced-motion user keeps the full form in a
  // band that cannot hold it.
  const reducedMotion = useProvidedMotionPolicy()?.reducedMotion ?? false;
  const refreshReserve = reducedMotion ? REFRESH_PROGRESS_REDUCED_MOTION_HEIGHT : 0;
  const compactEmptyState =
    getEmptyStatePresentation({
      available: bodyHeight,
      bottomInset: centeredBottomInset,
      reservedHeight: refreshReserve,
      fontScale,
    }) === 'compact';
  // The accepted-empty body stacks its See-all history link under the
  // new-session button, so its full form is a row taller than the single-action
  // no-match state: a band that holds one action can still be too short for two,
  // and the decision must compact before the history link sits behind the bar.
  const compactLiveEmptyState =
    getEmptyStatePresentation({
      available: bodyHeight,
      bottomInset: centeredBottomInset,
      reservedHeight: refreshReserve,
      fontScale,
      secondaryAction: true,
    }) === 'compact';

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

  return {
    onBodyLayout,
    fabStyle,
    sidePadding,
    centeredBottomInset,
    compactEmptyState,
    compactLiveEmptyState,
  };
}
