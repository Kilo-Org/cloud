import { View } from 'react-native';

import { SECTION_LABEL_AIR_CLASS } from '@/components/ui/section-header';
import { Skeleton } from '@/components/ui/skeleton';
import {
  SECTION_ACTION_BOX_CLASS,
  SECTION_HEADER_ROW_PADDING_CLASS,
  textActionTargetClass,
} from '@/lib/a11y/tap-target';
import { SCREEN_GUTTER_CLASS } from '@/lib/layout';
import { cn } from '@/lib/utils';

/** The label's line, held by the loading twin so the swap to the real label cannot move the block. */
const LABEL_BAR_CLASS = 'h-3.5 w-16 max-w-full shrink rounded bg-muted-soft';
/** The action's box, at the frame the text action itself renders. */
const ACTION_BAR_CLASS = 'w-12 shrink-0 rounded bg-muted-soft';

type SectionHeaderSkeletonProps = {
  /**
   * Reserve the trailing action's box, so a section that loads its action later
   * does not grow by the action's frame when the real header paints.
   */
  action?: boolean;
  /** Mirror a header that reserves its label air (`reserveLabelAir`). */
  reserveLabelAir?: boolean;
  /** Mirror a header that draws the page gutter (`inset`). */
  inset?: boolean;
};

/**
 * The loading shape of a section header: the label's line, and the action's box
 * when the header will carry one. It renders on the header's own row classes,
 * so it holds exactly the height the real header takes with or without an
 * action and the swap cannot move the block below it.
 *
 * It lives beside `SectionHeader` rather than inside it: the animated fill loads
 * Reanimated, and every screen that paints a header would otherwise pull that
 * through a header it renders fully.
 */
export function SectionHeaderSkeleton({
  action = false,
  reserveLabelAir = false,
  inset = false,
}: Readonly<SectionHeaderSkeletonProps>) {
  const labelBar = <Skeleton className={LABEL_BAR_CLASS} />;
  const actionBar = action ? (
    <Skeleton
      className={cn(
        reserveLabelAir ? SECTION_ACTION_BOX_CLASS : textActionTargetClass(),
        ACTION_BAR_CLASS
      )}
    />
  ) : null;
  return (
    <View
      className={cn(
        'flex-row flex-wrap items-end justify-end gap-2',
        inset && SCREEN_GUTTER_CLASS,
        reserveLabelAir ? SECTION_HEADER_ROW_PADDING_CLASS : 'py-2'
      )}
    >
      {reserveLabelAir ? (
        <View className={cn('grow flex-col justify-end', SECTION_LABEL_AIR_CLASS)}>{labelBar}</View>
      ) : (
        <View className="min-w-0 grow">{labelBar}</View>
      )}
      {actionBar}
    </View>
  );
}
