/**
 * The profile commands screen's skeleton. The screen file owns the list and
 * its save machinery; this part draws the loading cards, so the screen stays
 * under the file-size bound.
 */

import { View } from 'react-native';

import { Skeleton } from '@/components/ui/skeleton';

/** Content-shaped cards in the same slots as a loaded command row. */
export function CommandsSkeleton() {
  return (
    <View className="gap-3">
      {[0, 1, 2].map(index => (
        <View key={index} className="gap-1.5 rounded-lg bg-secondary p-3">
          <View className="h-[48px] flex-row items-center justify-between">
            <Skeleton className="h-4 w-20 rounded bg-muted-soft" />
            <Skeleton className="h-[48px] w-[151px] rounded bg-muted-soft" />
          </View>
          <Skeleton className="h-[44px] w-full rounded-md bg-muted-soft" />
        </View>
      ))}
    </View>
  );
}
