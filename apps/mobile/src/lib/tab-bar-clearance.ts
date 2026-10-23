import { createContext, useContext } from 'react';
import { Platform, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { getEffectiveTabBarHeight } from '@/lib/tab-bar-layout';

/**
 * Whether a tab bar sits under the screen, and — when it does — the tab layout's
 * label decision for the current window, published so content clearance matches
 * the rendered bar height. The decision turns on the window width, which a
 * clearance caller cannot see from `fontScale` alone: without it a caller
 * reserves the label-inclusive height while the bar renders compact (labels
 * dropped for width).
 *
 * - a boolean is the tabs layout's answer for the window;
 * - `null` is the app's root stack, which draws no bar above the tabs and no
 *   bar under its own screens;
 * - `undefined` is a screen rendered without either layout (a mounted test of
 *   a tab screen), which keeps the font-scale default.
 */
export const TabBarLabelContext = createContext<boolean | null | undefined>(undefined);

/**
 * Effective rendered tab bar height for a screen's content clearance: the tab
 * layout's label decision (`TabBarLabelContext`), the safe-area bottom inset and
 * the platform. A root-stack screen has no bar under it, so it clears the
 * safe-area inset alone instead of reserving a bar that is not on screen.
 */
export function useEffectiveTabBarHeight(): number {
  const { bottom } = useSafeAreaInsets();
  const { fontScale } = useWindowDimensions();
  const showLabel = useContext(TabBarLabelContext);
  if (showLabel === null) {
    return bottom;
  }
  return getEffectiveTabBarHeight({
    bottomInset: bottom,
    platform: Platform.OS,
    fontScale,
    showLabel,
  });
}
