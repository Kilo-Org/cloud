import { View } from 'react-native';

import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';

/**
 * The placeholder the request-log window paints while its first hour loads.
 *
 * Each card keeps the loaded row's own geometry — the card's own surface and
 * inset, a `text-sm` line box (`h-5`, 17.5 dp at the native rem of 14) and two
 * `text-xs` line boxes (`h-4`, 14 dp) — so the cards that
 * arrive land on the lines the placeholders drew instead of growing the list.
 * The first two lines keep the short end-side bar their cost and provider fill,
 * and the third keeps the time and token bars beside it.
 */
function RowSkeleton() {
  return (
    <Card className="mx-4">
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
    </Card>
  );
}

/**
 * Three placeholder cards on the loaded rows' own gutter and section gap. The
 * cards carry the page gutter themselves, exactly as `RequestLogRow` does;
 * adding one to the wrapper would inset every placeholder twice.
 */
export function RequestLogsSkeleton() {
  return (
    <View className="gap-3 pt-3">
      <RowSkeleton />
      <RowSkeleton />
      <RowSkeleton />
    </View>
  );
}
