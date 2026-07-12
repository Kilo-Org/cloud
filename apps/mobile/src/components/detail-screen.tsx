import { ScrollView, type ScrollViewProps, View } from 'react-native';

import { useDetailScreenBottomPadding } from '@/lib/screen-insets';

// Detail-screen counterpart to TabScreenScrollView. Provides bottom clearance via
// a trailing spacer instead of contentContainerStyle — setting that style prop
// makes NativeWind drop the caller's contentContainerClassName (padding/gap).
export function DetailScreenScrollView({ children, ...props }: ScrollViewProps) {
  const paddingBottom = useDetailScreenBottomPadding();
  return (
    <ScrollView {...props}>
      {children}
      <View style={{ height: paddingBottom }} pointerEvents="none" />
    </ScrollView>
  );
}
