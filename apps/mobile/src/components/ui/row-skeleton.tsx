import { View } from 'react-native';

import { ROW_FRAME_CLASS, ROW_FRAME_STACK_CLASS, ROW_TILE_CLASS } from '@/components/ui/row-frame';
import { Skeleton } from '@/components/ui/skeleton';
import { ICON_TARGET_BOX_CLASS } from '@/lib/a11y/tap-target';
import { cn } from '@/lib/utils';

/** The hue strip, at the 3pt bar the session row draws. */
const STRIP_CLASS = 'w-[3px] self-stretch rounded-[2px] bg-muted-soft';
/** The bars hold the height of the lines they stand in for (`text-sm` 17.5pt, `text-xs` 14pt), so the swap to real rows never shifts the screen. */
const TITLE_BAR_CLASS = 'h-5 w-40 max-w-full rounded bg-muted-soft';
const SUBTITLE_BAR_CLASS = 'h-4 w-56 max-w-full rounded bg-muted-soft';
const SECOND_SUBTITLE_BAR_CLASS = 'h-4 w-32 max-w-full rounded bg-muted-soft';
const EYEBROW_BAR_CLASS = 'h-2 w-24 max-w-full rounded bg-muted-soft';
const META_BAR_CLASS = 'h-3 w-20 shrink-0 rounded bg-muted-soft';
/** The 48pt box a row's trailing icon control occupies. */
const TRAILING_CONTROL_CLASS = 'shrink-0 rounded-lg bg-muted-soft';
/** The switch's own pill, so the loaded control does not move the row it sits in. */
const TRAILING_SWITCH_CLASS = 'h-[31px] w-[51px] shrink-0 rounded-full bg-muted-soft';

type RowSkeletonProps = {
  /** Reserve the 30pt leading tile of a row that leads with an icon. */
  tile?: boolean;
  /** Reserve the subtitle line under the title. */
  subtitle?: boolean;
  /**
   * The number of text bars to reserve: `1` a title-only row, `2` title and
   * subtitle, `3` title and two subtitle lines. Defaults to `subtitle ? 2 : 1`.
   */
  lines?: 1 | 2 | 3;
  /** Reserve the 48pt box of a trailing icon control (edit, delete, reorder). */
  trailingControl?: boolean;
  /** Reserve the switch a preference row ends in. */
  trailing?: 'switch';
  /**
   * The frame the loaded row takes in a narrow window (under 240dp) or at a
   * large font scale: the leading cell above the text block, which gets the
   * row's full width.
   */
  stack?: boolean;
  /**
   * `row` is a grouped card's row: tile, title and optional subtitle.
   * `session` is the flat list's session row: hue strip, eyebrow, title, meta.
   */
  variant?: 'row' | 'session';
  /** The last flat-list row draws no divider under it. */
  last?: boolean;
  className?: string;
};

/**
 * The loading shape of a row primitive.
 *
 * A skeleton that mirrors the row's own geometry is the only loading state that
 * can hand over to the real rows without moving them; a hand-sized box at the
 * call site drifts from the primitive the moment the primitive changes. The row
 * variant renders `ROW_FRAME_CLASS` and `ROW_TILE_CLASS` from `row-frame`, so
 * the skeleton and the row share one geometry instead of two copies.
 *
 * The bars sit on `bg-muted-soft` because the theme's `bg-muted` equals
 * `bg-secondary`, which is the grouped card's own fill.
 */
export function RowSkeleton({
  tile = false,
  subtitle = false,
  lines,
  trailingControl = false,
  trailing,
  stack = false,
  variant = 'row',
  last = false,
  className,
}: Readonly<RowSkeletonProps>) {
  const lineCount = lines ?? (subtitle ? 2 : 1);

  if (variant === 'session') {
    return (
      <View
        className={cn(
          'flex-row items-center gap-3 px-4 py-3',
          !last && 'border-b-[0.5px] border-hair-soft',
          className
        )}
      >
        <View className={STRIP_CLASS} />
        <View className="min-w-0 flex-1 gap-1">
          <Skeleton className={EYEBROW_BAR_CLASS} />
          <Skeleton className={TITLE_BAR_CLASS} />
          {lineCount > 1 ? <Skeleton className={SUBTITLE_BAR_CLASS} /> : null}
        </View>
        <Skeleton className={META_BAR_CLASS} />
      </View>
    );
  }

  if (stack) {
    return (
      <View className={cn(ROW_FRAME_STACK_CLASS, className)}>
        <View className="w-full flex-row items-center justify-between gap-3">
          {tile ? (
            <Skeleton className={cn(ROW_TILE_CLASS, 'bg-muted-soft')} />
          ) : (
            <View className="flex-1" />
          )}
          {trailing === 'switch' ? <Skeleton className={TRAILING_SWITCH_CLASS} /> : null}
          {trailingControl ? (
            <Skeleton className={cn(ICON_TARGET_BOX_CLASS, TRAILING_CONTROL_CLASS)} />
          ) : null}
        </View>
        <View className="min-w-0 w-full gap-1">
          <Skeleton className={TITLE_BAR_CLASS} />
          {lineCount > 1 ? <Skeleton className={SUBTITLE_BAR_CLASS} /> : null}
          {lineCount > 2 ? <Skeleton className={SECOND_SUBTITLE_BAR_CLASS} /> : null}
        </View>
      </View>
    );
  }

  return (
    <View className={cn(ROW_FRAME_CLASS, className)}>
      {tile ? <Skeleton className={cn(ROW_TILE_CLASS, 'bg-muted-soft')} /> : null}
      <View className="min-w-0 flex-1 gap-1">
        <Skeleton className={TITLE_BAR_CLASS} />
        {lineCount > 1 ? <Skeleton className={SUBTITLE_BAR_CLASS} /> : null}
        {lineCount > 2 ? <Skeleton className={SECOND_SUBTITLE_BAR_CLASS} /> : null}
      </View>
      {trailing === 'switch' ? <Skeleton className={TRAILING_SWITCH_CLASS} /> : null}
      {trailingControl ? (
        <Skeleton className={cn(ICON_TARGET_BOX_CLASS, TRAILING_CONTROL_CLASS)} />
      ) : null}
    </View>
  );
}
