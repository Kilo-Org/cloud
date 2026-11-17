import { View } from 'react-native';

import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

/**
 * Enough rows to fill the list's first frame: a flat finding row is shorter
 * than the card it replaced, so the placeholder keeps the screen covered until
 * the first page lands.
 */
const SKELETON_ROW_COUNT = 6;

/**
 * One finding row's placeholder. `RowSkeleton`'s title-and-subtitle shape is a
 * grouped row; a finding row stacks five boxes — the severity eyebrow, the
 * title, the repository caption, the analysis/deadline line and the quick
 * action — so its placeholder is built from those same line boxes at the row's
 * own frame. Handing over to the loaded rows then keeps the list where it is.
 */
export function FindingRowSkeleton({ last = false }: Readonly<{ last?: boolean }>) {
  return (
    <View
      testID="finding-row-skeleton"
      className={cn('gap-1 px-4 py-3', !last && 'border-b-[0.5px] border-hair-soft')}
    >
      <Skeleton className="h-2 w-16 max-w-full rounded" />
      <Skeleton className="h-5 w-full max-w-full rounded" />
      <Skeleton className="h-4 w-2/3 max-w-full rounded" />
      <View className="flex-row items-center gap-3 pt-0.5">
        <Skeleton className="h-3 w-24 max-w-full rounded" />
        <Skeleton className="h-3 w-16 max-w-full rounded" />
      </View>
      <Skeleton className="mt-1 h-8 w-24 rounded-md" />
    </View>
  );
}

/** The placeholder rows of a findings list, full-bleed like the loaded rows. */
export function FindingListSkeletonRows() {
  return (
    <View testID="finding-list-skeleton">
      {Array.from({ length: SKELETON_ROW_COUNT }, (_, index) => (
        <FindingRowSkeleton key={index} last={index === SKELETON_ROW_COUNT - 1} />
      ))}
    </View>
  );
}
