import { View } from 'react-native';

import { FINDING_ROW_FRAME_CLASS } from '@/components/security-agent/finding-row';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

const SKELETON_ROW_COUNT = 3;

/** Title bar widths, varied per row so the list does not read as a grid. */
const TITLE_WIDTHS = ['w-3/4', 'w-2/3', 'w-1/2'] as const;
const REPO_WIDTHS = ['w-1/3', 'w-2/5', 'w-1/4'] as const;

/**
 * The line boxes a finding card gives its text at the app's 14pt rem: the 11px
 * severity label, a one-line `text-sm` title, the `text-xs` repository, the meta
 * row beside it behind `pt-0.5`, and the quick action behind `mt-1`, which is the
 * card's button. Each box holds a bar of its own, so the placeholder stands in
 * the card's frame and the cards replace it in place.
 *
 * A card is content-sized, so the frame covers the shape the list shows for a
 * finding that offers an action: 143.6 points measured against the card's own
 * 144.0. Three variants differ, and neither is reserved because a placeholder
 * cannot stand for all of them: a card whose quick action is the one-line
 * `text-xs` label is shorter by the button's height, a card with no action
 * measured 99.0 points, and a title that wraps to its second line adds one
 * `text-sm` box while a meta row that wraps adds one `text-xs` box.
 */
const SEVERITY_LINE_CLASS = 'h-[15px] justify-center';
const TITLE_LINE_CLASS = 'h-[17.5px] justify-center';
const REPO_LINE_CLASS = 'h-[14px] justify-center';
const META_LINE_CLASS = 'h-[14px] flex-row items-center gap-3';
const ACTION_CLASS = 'mt-1';

/**
 * One finding card's placeholder. `index` only varies the bar widths; every
 * row reserves the same card frame, so a three-row placeholder stands exactly
 * where three cards will.
 */
export function FindingRowSkeleton({ index }: Readonly<{ index: number }>) {
  const variant = index % TITLE_WIDTHS.length;
  return (
    <View testID="finding-row-skeleton" className={FINDING_ROW_FRAME_CLASS}>
      <View className="gap-1.5">
        <View className={SEVERITY_LINE_CLASS}>
          <Skeleton className="h-2.5 w-16 rounded-full" />
        </View>
        <View className={TITLE_LINE_CLASS}>
          <Skeleton className={cn('h-3.5 rounded-full', TITLE_WIDTHS[variant])} />
        </View>
        <View className={REPO_LINE_CLASS}>
          <Skeleton className={cn('h-2.5 rounded-full', REPO_WIDTHS[variant])} />
        </View>
        <View className="pt-0.5">
          <View className={META_LINE_CLASS}>
            <Skeleton className="h-2.5 w-20 rounded-full" />
            <Skeleton className="h-2.5 w-16 rounded-full" />
          </View>
        </View>
      </View>
      <View className={ACTION_CLASS}>
        <Skeleton className="h-[36px] w-24 rounded-md" />
      </View>
    </View>
  );
}

/**
 * The placeholder rows of a findings list, separated by the same `h-3` band the
 * loaded list's item separator paints, so a row keeps its place from the first
 * paint to the loaded card.
 */
export function FindingListSkeletonRows() {
  return (
    <>
      {Array.from({ length: SKELETON_ROW_COUNT }, (_, index) => (
        <View key={index} className={index === 0 ? undefined : 'pt-3'}>
          <FindingRowSkeleton index={index} />
        </View>
      ))}
    </>
  );
}
