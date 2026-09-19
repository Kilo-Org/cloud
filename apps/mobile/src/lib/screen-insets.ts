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
