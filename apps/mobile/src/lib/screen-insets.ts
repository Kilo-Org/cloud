import { useSafeAreaInsets } from 'react-native-safe-area-context';

// Non-tab detail screens (no tab bar clearance needed) — floors bottom inset
// at 16 so devices without a home indicator still get breathing room.
export function useDetailScreenBottomPadding() {
  const { bottom } = useSafeAreaInsets();
  return Math.max(bottom, 16) + 16;
}

// A side status area can leave the top inset at zero beside rounded corners.
// Keep the native exclusion and add corner clearance before the screen's gutters.
export function useScreenInsets() {
  const insets = useSafeAreaInsets();
  if (insets.top === 0 && insets.left > 0 !== insets.right > 0) {
    return {
      ...insets,
      top: 24,
      left: Math.max(insets.left, 8),
      right: Math.max(insets.right, 8),
    };
  }
  return insets;
}

// Apply this style to a wrapper outside the screen's gutter container.
// Inline padding on the gutter container would replace its className padding.
type SideInsetStyle = {
  paddingLeft?: number;
  paddingRight?: number;
};

export function useSideInsetStyle(): SideInsetStyle | undefined {
  const { left, right } = useScreenInsets();
  return left > 0 || right > 0
    ? {
        ...(left > 0 ? { paddingLeft: left } : undefined),
        ...(right > 0 ? { paddingRight: right } : undefined),
      }
    : undefined;
}
