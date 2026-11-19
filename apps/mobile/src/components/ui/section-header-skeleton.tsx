import { View } from 'react-native';

import { Skeleton } from '@/components/ui/skeleton';
import { EYEBROW_LINE_HEIGHT_DP } from '@/components/ui/text';
import { SCREEN_GUTTER_CLASS } from '@/lib/layout';
import { cn } from '@/lib/utils';

/**
 * The label's line, reserved at the height the loaded label lays out on
 * (`EYEBROW_LINE_HEIGHT_DP`), with the bar centred inside it.
 */
const LABEL_LINE_CLASS = 'min-w-0 grow justify-center';
/** That line's height, as the loaded eyebrow declares it. */
const LABEL_LINE_STYLE = { height: EYEBROW_LINE_HEIGHT_DP } as const;
/** The bar inside the line: a mark at the label's glyph size, never the line. */
const LABEL_BAR_CLASS = 'h-3.5 w-16 max-w-full shrink rounded bg-muted-soft';
/** The action's band: the one line the real action holds in the row, at the same outer edge. */
const ACTION_BAR_CLASS = 'ms-auto h-3.5 w-12 shrink self-center rounded bg-muted-soft';

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
 * and its bar sits inside a box of the eyebrow's line height, so it holds exactly
 * the height the real header takes with or without an action and the swap
 * cannot move the block below it.
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
      <View className={LABEL_LINE_CLASS} style={LABEL_LINE_STYLE}>
        <Skeleton className={LABEL_BAR_CLASS} />
      </View>
      {action ? <Skeleton className={ACTION_BAR_CLASS} /> : null}
    </View>
  );
}
