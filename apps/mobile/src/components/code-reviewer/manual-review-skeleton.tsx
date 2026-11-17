import { View } from 'react-native';

import { RowGroup } from '@/components/ui/row-group';
import { RowSkeleton } from '@/components/ui/row-skeleton';
import { Skeleton } from '@/components/ui/skeleton';
import { SCREEN_BODY_CLASS } from '@/lib/layout';

/**
 * Loading placeholder for the manual review body while the provider status is
 * still settling: the platform rows the picker renders, so the page never shows
 * nothing under its header and the state that arrives keeps the same shape.
 *
 * It paints from the first frame: a placeholder is the only thing on screen
 * while the status is unknown, so it must not settle a layout pass later.
 */
export function ManualReviewSkeleton() {
  return (
    <View className={SCREEN_BODY_CLASS}>
      <RowGroup>
        <RowSkeleton subtitle />
        <RowSkeleton subtitle />
      </RowGroup>
      <View className="gap-3">
        <Skeleton className="h-3 w-24 max-w-full rounded bg-muted-soft" />
        <Skeleton className="h-12 w-full rounded-md bg-muted-soft" />
        <Skeleton className="h-3 w-32 max-w-full rounded bg-muted-soft" />
        <Skeleton className="h-24 w-full rounded-md bg-muted-soft" />
      </View>
    </View>
  );
}
