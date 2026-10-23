import { createContext, useContext } from 'react';
import { Platform, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { getEffectiveTabBarHeight } from '@/lib/tab-bar-layout';

/**
 * The tab layout's label decision for the current window, published to the tab
 * screens so their content clearance matches the rendered bar height. Both the
 * visible/hidden decision and the reserved line count can change without the
 * font scale: one label too wide for its tab takes a second line, which makes
 * the bar taller. `null` outside the tabs navigator, where
 * `getEffectiveTabBarHeight` keeps its font-scale-only default.
 */
export type TabBarLabelState = { showLabel: boolean; labelLines: 1 | 2 };

export const TabBarLabelContext = createContext<TabBarLabelState | null>(null);

/**
 * Effective rendered tab bar height for a screen's content clearance: the tabs
 * layout's label decision (`TabBarLabelContext`), the safe-area bottom inset and
 * the platform.
 */
export function useEffectiveTabBarHeight(): number {
  const { bottom } = useSafeAreaInsets();
  const { fontScale } = useWindowDimensions();
  const state = useContext(TabBarLabelContext) ?? undefined;
  return getEffectiveTabBarHeight({
    bottomInset: bottom,
    platform: Platform.OS,
    fontScale,
    showLabel: state?.showLabel,
    labelLines: state?.labelLines,
  });
}
