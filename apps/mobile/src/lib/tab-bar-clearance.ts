import { createContext, useContext } from 'react';
import { Platform, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { getEffectiveTabBarHeight } from '@/lib/tab-bar-layout';

/**
 * The tab layout's label decision for the current window, published to the tab
 * screens so their content clearance matches the rendered bar height. The
 * decision turns on the window width, which a clearance caller cannot see from
 * `fontScale` alone: without it a caller reserves the label-inclusive height
 * while the bar renders compact (labels dropped for width). `null` outside the
 * tabs navigator, where `getEffectiveTabBarHeight` keeps its font-scale-only
 * default.
 */
export const TabBarLabelContext = createContext<boolean | null>(null);

/**
 * Effective rendered tab bar height for a screen's content clearance: the tabs
 * layout's label decision (`TabBarLabelContext`), the safe-area bottom inset and
 * the platform.
 */
export function useEffectiveTabBarHeight(): number {
  const { bottom } = useSafeAreaInsets();
  const { fontScale } = useWindowDimensions();
  const showLabel = useContext(TabBarLabelContext) ?? undefined;
  return getEffectiveTabBarHeight({
    bottomInset: bottom,
    platform: Platform.OS,
    fontScale,
    showLabel,
  });
}
