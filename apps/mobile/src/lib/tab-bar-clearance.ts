import { createContext, useContext, useSyncExternalStore } from 'react';
import { Platform, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { getEffectiveTabBarHeight } from '@/lib/tab-bar-layout';

/**
 * The tab layout's answer for the current window, published so content
 * clearance matches the rendered bar height. Both fields can change without the
 * font scale: one label too wide for its tab takes a second line, which makes
 * the bar taller.
 *
 * - an object is the tabs layout's answer for the window: whether the labels
 *   render and how many lines the tallest of them reserves;
 * - `null` is the app's root stack, which draws no bar above the tabs and no
 *   bar under its own screens;
 * - `undefined` is a screen rendered without either layout (a mounted test of
 *   a tab screen), which keeps the font-scale default.
 */
export type TabBarLabelState = { showLabel: boolean; labelLines: 1 | 2 };

export const TabBarLabelContext = createContext<TabBarLabelState | null | undefined>(undefined);

/**
 * Effective rendered tab bar height for a screen's content clearance: the tab
 * layout's answer (`TabBarLabelContext`), the safe-area bottom inset and the
 * platform. A root-stack screen has no bar under it, so it clears the safe-area
 * inset alone instead of reserving a bar that is not on screen.
 */
export function useEffectiveTabBarHeight(): number {
  const { bottom } = useSafeAreaInsets();
  const { fontScale } = useWindowDimensions();
  const state = useContext(TabBarLabelContext);
  if (state === null) {
    return bottom;
  }
  return getEffectiveTabBarHeight({
    bottomInset: bottom,
    platform: Platform.OS,
    fontScale,
    showLabel: state?.showLabel,
    labelLines: state?.labelLines,
  });
}

let renderedHeight: number | null = null;
const renderedHeightListeners = new Set<() => void>();

/**
 * The height of the tab bar the tabs layout is rendering, or `null` when it
 * renders none. A surface above the tabs navigator — the toaster, which is
 * mounted at the app root — cannot read `TabBarLabelContext`, so the layout
 * publishes its own measurement and every consumer clears exactly that bar.
 */
export function publishRenderedTabBarHeight(height: number | null) {
  if (renderedHeight === height) {
    return;
  }
  renderedHeight = height;
  for (const listener of renderedHeightListeners) {
    listener();
  }
}

function subscribeRenderedTabBarHeight(listener: () => void) {
  renderedHeightListeners.add(listener);
  return () => {
    renderedHeightListeners.delete(listener);
  };
}

export function useRenderedTabBarHeight(): number | null {
  return useSyncExternalStore(
    subscribeRenderedTabBarHeight,
    () => renderedHeight,
    () => renderedHeight
  );
}
