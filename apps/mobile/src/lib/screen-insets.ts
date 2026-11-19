import { createContext, use } from 'react';
import { I18nManager, Platform } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

// Non-tab detail screens (no tab bar clearance needed) — floors bottom inset
// at 16 so devices without a home indicator still get breathing room.
export function useDetailScreenBottomPadding() {
  const { bottom } = useSafeAreaInsets();
  return Math.max(bottom, 16) + 16;
}

/**
 * Set by a surface that clears the window's side insets itself. Android
 * presents an imperative `Sheet` in a dialog window that Material3 caps at
 * 640dp and centres, so the sheet's edges never reach a landscape cutout; the
 * root window's side insets do not describe that surface, and content that
 * added them would sit a whole cutout width off the sheet's own gutter.
 */
const SurfaceClearsSideInsetsContext = createContext(false);

export const SurfaceClearsSideInsets = SurfaceClearsSideInsetsContext.Provider;

// A side status area can leave the top inset at zero beside rounded corners.
// Keep the native exclusion and add corner clearance before the screen's gutters.
export function useScreenInsets() {
  const insets = useSafeAreaInsets();
  if (insets.left === 0 && insets.right === 0) {
    return insets;
  }
  const cornerPadded =
    insets.top === 0 && insets.left > 0 !== insets.right > 0
      ? {
          ...insets,
          top: 24,
          left: Math.max(insets.left, 8),
          right: Math.max(insets.right, 8),
        }
      : insets;
  return use(SurfaceClearsSideInsetsContext) && Platform.OS === 'android'
    ? { ...cornerPadded, left: 0, right: 0 }
    : cornerPadded;
}

/**
 * The side insets as the style props React Native will apply them to. The
 * safe-area insets are physical: a landscape cutout is on the left or the right
 * of the glass whatever the language. React Native, though, rewrites a
 * `Left`/`Right` padding or margin to the layout's start/end in a right-to-left
 * tree (`I18nManager.doLeftAndRightSwapInRTL`, on by default), so the values
 * are swapped there to land each inset back on its own physical side.
 */
export function useStyleSideInsets() {
  const { left, right } = useScreenInsets();
  if (left === right) {
    return { left, right };
  }
  const swapped = I18nManager.isRTL && I18nManager.doLeftAndRightSwapInRTL;
  return swapped ? { left: right, right: left } : { left, right };
}

// Apply this style to a wrapper outside the screen's gutter container.
// Inline padding on the gutter container would replace its className padding.
type SideInsetStyle = {
  paddingLeft?: number;
  paddingRight?: number;
};

export function useSideInsetStyle(): SideInsetStyle | undefined {
  const { left, right } = useStyleSideInsets();
  return left > 0 || right > 0
    ? {
        ...(left > 0 ? { paddingLeft: left } : undefined),
        ...(right > 0 ? { paddingRight: right } : undefined),
      }
    : undefined;
}

type SideInsetMarginStyle = {
  marginLeft?: number;
  marginRight?: number;
};

/**
 * The side insets as margins, for a scroller's own `style`. A padding there
 * does not narrow the scroll content (see the scroll-view inset rule in
 * `apps/mobile/AGENTS.md`), and a formSheet's list must stay a direct child of
 * the sheet, so it cannot take a padded wrapper either.
 */
export function useSideInsetMarginStyle(): SideInsetMarginStyle | undefined {
  const { left, right } = useStyleSideInsets();
  return left > 0 || right > 0
    ? {
        ...(left > 0 ? { marginLeft: left } : undefined),
        ...(right > 0 ? { marginRight: right } : undefined),
      }
    : undefined;
}
