import {
  Platform,
  ScrollView,
  type ScrollViewProps,
  useWindowDimensions,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { getTabBarOverlayHeight } from '@/lib/tab-bar-layout';

// FlatList/FlashList screens use this directly for contentContainerStyle.paddingBottom.
export function useTabBarBottomPadding() {
  const { bottom } = useSafeAreaInsets();
  const { fontScale } = useWindowDimensions();
  return getTabBarOverlayHeight(bottom, Platform.OS, fontScale) + 16;
}

export function TabScreenScrollView({ children, ...props }: ScrollViewProps) {
  const paddingBottom = useTabBarBottomPadding();
  // Provide tab-bar clearance via a trailing spacer rather than overriding
  // contentContainerStyle — setting that style prop makes NativeWind drop the
  // caller's contentContainerClassName (gap/padding), collapsing section spacing.
  return (
    <ScrollView {...props}>
      {children}
      <View style={{ height: paddingBottom }} pointerEvents="none" />
    </ScrollView>
  );
}
