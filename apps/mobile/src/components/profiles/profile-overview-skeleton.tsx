import { View } from 'react-native';

import { Card } from '@/components/ui/card';
import { RowGroup } from '@/components/ui/row-group';
import { RowSkeleton } from '@/components/ui/row-skeleton';
import { Skeleton } from '@/components/ui/skeleton';

/**
 * Content-shaped loading blocks in the same slots as the loaded screen (the
 * metadata card, the default row, the repo-pins section, the settings rows and
 * the delete action) so the swap to real content does not move anything. The
 * rows are the row primitive's own skeleton; the blocks use the card and row
 * group surfaces the loaded screen uses.
 */
export function ProfileOverviewSkeleton() {
  return (
    <View className="gap-6">
      <Card>
        <View className="gap-1.5">
          <Skeleton className="h-4 w-24 rounded bg-muted-soft" />
          <Skeleton className="h-11 w-full rounded-md bg-muted-soft" />
        </View>
        <View className="gap-1.5">
          <Skeleton className="h-4 w-32 rounded bg-muted-soft" />
          <Skeleton className="h-20 w-full rounded-md bg-muted-soft" />
        </View>
        <Skeleton className="h-11 w-full rounded-md bg-muted-soft" />
      </Card>
      <RowGroup>
        <RowSkeleton tile subtitle />
      </RowGroup>
      <View className="gap-3">
        <Skeleton className="h-2 w-28 rounded bg-muted-soft" />
        <Skeleton className="h-3 w-56 rounded bg-muted-soft" />
        <RowGroup>
          <RowSkeleton subtitle />
        </RowGroup>
      </View>
      <View className="gap-3">
        <Skeleton className="h-2 w-24 rounded bg-muted-soft" />
        <RowGroup>
          {[0, 1, 2, 3, 4, 5].map(index => (
            <RowSkeleton key={index} tile subtitle />
          ))}
        </RowGroup>
      </View>
      <Skeleton className="h-11 w-full rounded-md bg-muted-soft" />
    </View>
  );
}
