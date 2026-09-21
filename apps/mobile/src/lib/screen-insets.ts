import { useSafeAreaInsets } from 'react-native-safe-area-context';

// Non-tab detail screens (no tab bar clearance needed) — floors bottom inset
// at 16 so devices without a home indicator still get breathing room.
export function useDetailScreenBottomPadding() {
  const { bottom } = useSafeAreaInsets();
  return Math.max(bottom, 16) + 16;
}

// The app's one cross-platform entry point for the landscape side insets: the
// notch/Dynamic Island on iOS and the display cutout on Android.
// `react-native-safe-area-context` reports the same left/right contract on both
// platforms, so screens read them here instead of importing the native module
// again, and nothing on this path branches on the platform. A device without a
// side inset reports zero, which leaves a caller's own gutter unchanged.
export function useScreenSideInsets() {
  const { left, right } = useSafeAreaInsets();
  return { left, right };
}

// Landscape side safe areas (the notch/Dynamic Island inset on iOS, the display
// cutout on Android) shift a screen's chrome off the sensor. One implementation
// for both platforms: the safe-area context reports the same left/right cutout
// on each, both platforms have the capability, so no caller forks on the
// platform. The style ADDS to a caller's `px-4`/`mx-4` gutter (an inline
// padding on the gutter container would beat the className and swallow it).
// Zero side insets (portrait, or a device without a cutout) collapse to
// `undefined`, so the geometry is byte-identical and never moves on rotation.
type SideInsetStyle = {
  paddingLeft?: number;
  paddingRight?: number;
};

export function useSideInsetStyle(): SideInsetStyle | undefined {
  const { left, right } = useScreenSideInsets();
  return left > 0 || right > 0
    ? {
        ...(left > 0 ? { paddingLeft: left } : undefined),
        ...(right > 0 ? { paddingRight: right } : undefined),
      }
    : undefined;
}
