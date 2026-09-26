import { View } from 'react-native';

import { Skeleton } from '@/components/ui/skeleton';

/**
 * Content-shaped loading rows in the same slots as the loaded screen (two
 * fields, the default row, the six section rows, the delete button) so the
 * swap to real content does not move anything.
 */
export function ProfileOverviewSkeleton() {
  return (
    <View className="gap-6">
      <View className="gap-4">
        <View className="gap-1.5">
          <Skeleton className="h-4 w-24 rounded" />
          <Skeleton className="h-[44px] w-full rounded-md" />
        </View>
        <View className="gap-1.5">
          <Skeleton className="h-4 w-32 rounded" />
          <Skeleton className="h-20 w-full rounded-md" />
        </View>
        <Skeleton className="h-[44px] w-full rounded-md" />
      </View>
      <Skeleton className="h-16 w-full rounded-lg" />
      <View className="gap-3 rounded-lg border border-border p-3">
        <View className="flex-row items-center justify-between gap-2">
          <Skeleton className="h-4 w-40 rounded" />
          <Skeleton className="h-9 w-28 rounded-md" />
        </View>
        <Skeleton className="h-4 w-full rounded" />
        <Skeleton className="h-9 w-full rounded-md" />
      </View>
      <View className="gap-1">
        <Skeleton className="h-4 w-28 rounded" />
        <Skeleton className="h-[54px] w-full rounded-lg" />
        <Skeleton className="h-[54px] w-full rounded-lg" />
        <Skeleton className="h-[54px] w-full rounded-lg" />
        <Skeleton className="h-[54px] w-full rounded-lg" />
        <Skeleton className="h-[54px] w-full rounded-lg" />
        <Skeleton className="h-[54px] w-full rounded-lg" />
      </View>
      <Skeleton className="h-[44px] w-full rounded-md" />
    </View>
  );
}
