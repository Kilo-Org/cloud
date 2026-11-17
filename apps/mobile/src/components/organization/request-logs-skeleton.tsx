import { View } from 'react-native';

import { Skeleton } from '@/components/ui/skeleton';

/**
 * The placeholder the request-log window paints while its first hour loads.
 *
 * Each card keeps the loaded row's own geometry — `p-3`, `gap-1`, a `text-sm`
 * line that reserves 20 dp and two `text-xs` lines at 16 dp — so the cards that
 * arrive land on the lines the placeholders drew instead of growing the list.
 * The first two lines keep the short end-side bar their cost and provider fill,
 * and the third keeps the time and token bars beside it.
 */
function RowSkeleton() {
  return (
    <View className="gap-1 rounded-lg bg-secondary p-3">
      <View className="h-5 flex-row items-center gap-3">
        <Skeleton className="h-4 flex-1 rounded bg-muted-soft" />
        <Skeleton className="h-4 w-16 shrink-0 rounded bg-muted-soft" />
      </View>
      <View className="h-4 flex-row items-center gap-3">
        <Skeleton className="h-3 flex-1 rounded bg-muted-soft" />
        <Skeleton className="h-3 w-14 shrink-0 rounded bg-muted-soft" />
      </View>
      <View className="h-4 flex-row items-center gap-2">
        <Skeleton className="h-3 w-1/4 rounded bg-muted-soft" />
        <Skeleton className="h-3 w-32 rounded bg-muted-soft" />
      </View>
    </View>
  );
}

/** Three placeholder cards in the list's own inset: `px-6 pt-4` and `gap-3`. */
export function RequestLogsSkeleton() {
  return (
    <View className="gap-3 px-6 pt-4">
      <RowSkeleton />
      <RowSkeleton />
      <RowSkeleton />
    </View>
  );
}
