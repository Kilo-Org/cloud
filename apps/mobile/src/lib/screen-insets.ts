import { useSafeAreaInsets } from 'react-native-safe-area-context';

// Non-tab detail screens (no tab bar clearance needed) — floors bottom inset
// at 16 so devices without a home indicator still get breathing room.
export function useDetailScreenBottomPadding() {
  const { bottom } = useSafeAreaInsets();
  return Math.max(bottom, 16) + 16;
}
