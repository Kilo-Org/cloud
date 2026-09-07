import { Platform, ScrollView, type ScrollViewProps, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { RefreshProgress } from '@/components/ui/refresh-progress';
import { getEffectiveTabBarHeight } from '@/lib/tab-bar-layout';

const TAB_SCREEN_BOTTOM_GAP = 16;

// FlatList/FlashList screens use this directly for contentContainerStyle.paddingBottom.
export function useTabBarBottomPadding() {
  const { bottom } = useSafeAreaInsets();
  const { fontScale } = useWindowDimensions();
  return (
    getEffectiveTabBarHeight({ bottomInset: bottom, platform: Platform.OS, fontScale }) +
    TAB_SCREEN_BOTTOM_GAP
  );
}

export function TabScreenScrollView({
  children,
  style,
  refreshControl,
  ...props
}: ScrollViewProps) {
  const paddingBottom = useTabBarBottomPadding();
  return (
    <ScrollView
      {...props}
      refreshControl={refreshControl}
      style={[style, { marginBottom: paddingBottom }]}
    >
      {refreshControl ? <RefreshProgress refreshControl={refreshControl} /> : null}
      {children}
    </ScrollView>
  );
}
