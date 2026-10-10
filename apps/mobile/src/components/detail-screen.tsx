import { ScrollView, type ScrollViewProps, View } from 'react-native';

import { RefreshProgress } from '@/components/ui/refresh-progress';
import { useDetailScreenBottomPadding, useScreenInsets } from '@/lib/screen-insets';

// Detail-screen counterpart to TabScreenScrollView. Provides bottom clearance via
// a trailing spacer instead of contentContainerStyle — setting that style prop
// makes NativeWind drop the caller's contentContainerClassName (padding/gap).
export function DetailScreenScrollView({ children, style, ...props }: ScrollViewProps) {
  const paddingBottom = useDetailScreenBottomPadding();
  const { left, right } = useScreenInsets();
  return (
    <ScrollView
      {...props}
      style={[
        style,
        {
          ...(left > 0 ? { marginLeft: left } : undefined),
          ...(right > 0 ? { marginRight: right } : undefined),
        },
      ]}
    >
      {props.refreshControl ? <RefreshProgress refreshControl={props.refreshControl} /> : null}
      {children}
      <View style={{ height: paddingBottom }} pointerEvents="none" />
    </ScrollView>
  );
}
