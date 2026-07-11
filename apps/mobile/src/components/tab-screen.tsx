import { Platform, ScrollView, type ScrollViewProps } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { getTabBarOverlayHeight } from '@/lib/tab-bar-layout';

// FlatList/FlashList screens use this directly for contentContainerStyle.paddingBottom.
export function useTabBarBottomPadding() {
  const { bottom } = useSafeAreaInsets();
  return getTabBarOverlayHeight(bottom, Platform.OS) + 16;
}

export function TabScreenScrollView({ contentContainerStyle, ...props }: ScrollViewProps) {
  const paddingBottom = useTabBarBottomPadding();
  return (
    <ScrollView {...props} contentContainerStyle={[contentContainerStyle, { paddingBottom }]} />
  );
}
