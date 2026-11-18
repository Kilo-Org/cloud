import { View } from 'react-native';

import { Skeleton } from '@/components/ui/skeleton';
import { SCREEN_GUTTER_CLASS } from '@/lib/layout';
import { cn } from '@/lib/utils';

/** The label's line, held by the loading twin so the swap to the real label cannot move the block. */
const LABEL_BAR_CLASS = 'h-3.5 w-16 max-w-full shrink rounded bg-muted-soft';
/** The action's band: the one line the real action holds in the row, at the same outer edge. */
const ACTION_BAR_CLASS = 'ms-auto h-3.5 w-12 shrink rounded bg-muted-soft';

type SectionHeaderSkeletonProps = {
  /**
   * Reserve the trailing action's band, so a section that loads its action later
   * does not grow when the real header paints.
   */
  action?: boolean;
  /** Mirror a header that draws the page gutter (`inset`). */
  inset?: boolean;
};

/**
 * The loading shape of a section header: the label's line, and the action's band
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
  inset = false,
}: Readonly<SectionHeaderSkeletonProps>) {
  return (
    <View className={cn('flex-row flex-wrap items-end gap-2 py-2', inset && SCREEN_GUTTER_CLASS)}>
      <View className="min-w-0 grow">
        <Skeleton className={LABEL_BAR_CLASS} />
      </View>
      {action ? <Skeleton className={ACTION_BAR_CLASS} /> : null}
    </View>
  );
}
