import Animated, { FadeOut } from 'react-native-reanimated';
import { View } from 'react-native';

import { Skeleton } from '@/components/ui/skeleton';

/** Loading placeholder for a reviewer platform overview: one wide tile over a
 *  column of row-height tiles, matching the layout of the loaded content. */
export function PlatformOverviewSkeleton() {
  return (
    <Animated.View exiting={FadeOut.duration(150)} className="gap-3">
      <Skeleton className="h-16 w-full rounded-lg" />
      <View className="gap-2">
        {Array.from({ length: 6 }, (_, index) => (
          <Skeleton key={index} className="h-12 w-full rounded-lg" />
        ))}
      </View>
    </Animated.View>
  );
}
