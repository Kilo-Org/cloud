/**
 * The profile commands screen's skeleton. The screen file owns the list and
 * its save machinery; this part draws the loading blocks, so the screen stays
 * under the file-size bound.
 */

import { View } from 'react-native';

import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';

/** Content-shaped blocks in the same slots and card surface as a loaded command slot. */
export function CommandsSkeleton() {
  return (
    <View className="gap-3">
      {[0, 1, 2].map(index => (
        <Card key={index}>
          <View className="flex-row items-center justify-between gap-3">
            <Skeleton className="h-4 w-20 rounded bg-muted-soft" />
            <Skeleton className="h-8 w-28 rounded bg-muted-soft" />
          </View>
          <Skeleton className="h-11 w-full rounded-md bg-muted-soft" />
        </Card>
      ))}
    </View>
  );
}
