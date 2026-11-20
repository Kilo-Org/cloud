import Animated, { FadeOut } from 'react-native-reanimated';
import { View } from 'react-native';

import { Card } from '@/components/ui/card';
import { RowGroup } from '@/components/ui/row-group';
import { RowSkeleton } from '@/components/ui/row-skeleton';
import { Skeleton } from '@/components/ui/skeleton';

/** Loading placeholder for a reviewer platform overview: one block for the
 *  enable card over the row groups that follow it, at the primitives'
 *  geometry so the rows never move when the payload lands. */
export function PlatformOverviewSkeleton() {
  return (
    <Animated.View exiting={FadeOut.duration(150)} className="gap-6">
      <Card>
        <Skeleton className="h-4 w-40 max-w-full rounded bg-muted-soft" />
        <Skeleton className="h-3 w-56 max-w-full rounded bg-muted-soft" />
      </Card>
      <RowGroup leadingTile>
        {Array.from({ length: 6 }, (_, index) => (
          <RowSkeleton key={index} tile subtitle={index === 0} />
        ))}
      </RowGroup>
      <View className="gap-3">
        <Skeleton className="h-4 w-32 max-w-full rounded bg-muted-soft" />
        <Skeleton className="h-3 w-56 max-w-full rounded bg-muted-soft" />
      </View>
    </Animated.View>
  );
}
