import { View } from 'react-native';

import { Skeleton } from '@/components/ui/skeleton';

const SKELETON_ROW_COUNT = 8;

/**
 * The unresolved list's placeholder rows. Extracted from the screen body so
 * the screen stays inside the 300-line lint budget; the geometry is verbatim.
 */
export function SessionListSkeletonRows({
  sidePadding,
}: Readonly<{ sidePadding: { paddingLeft: number; paddingRight: number } }>) {
  return (
    <View className="pt-[18px]">
      {Array.from({ length: SKELETON_ROW_COUNT }, (_, i) => (
        <View key={i} className="py-1.5" style={sidePadding}>
          <Skeleton className="h-[76px] rounded-none" />
        </View>
      ))}
    </View>
  );
}
