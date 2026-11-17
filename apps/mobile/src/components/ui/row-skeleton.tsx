import { View } from 'react-native';

import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

/** The row's leading tile, at the 30pt frame `IconTile` draws. */
const TILE_CLASS = 'h-[30px] w-[30px] shrink-0 rounded-lg bg-muted-soft';
/** The hue strip, at the 3pt bar the session row draws. */
const STRIP_CLASS = 'w-[3px] self-stretch rounded-[2px] bg-muted-soft';
/** The bars hold the height of the lines they stand in for, so the swap to real rows never shifts the screen. */
const TITLE_BAR_CLASS = 'h-4 w-40 max-w-full rounded bg-muted-soft';
const SUBTITLE_BAR_CLASS = 'h-3 w-56 max-w-full rounded bg-muted-soft';
const EYEBROW_BAR_CLASS = 'h-2 w-24 max-w-full rounded bg-muted-soft';
const META_BAR_CLASS = 'h-3 w-20 shrink-0 rounded bg-muted-soft';

type RowSkeletonProps = {
  /** Reserve the 30pt leading tile of a row that leads with an icon. */
  tile?: boolean;
  /** Reserve the subtitle line under the title. */
  subtitle?: boolean;
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
 * call site drifts from the primitive the moment the primitive changes. The
 * bars sit on `bg-muted-soft` because the theme's `bg-muted` equals
 * `bg-secondary`, which is the grouped card's own fill.
 */
export function RowSkeleton({
  tile = false,
  subtitle = false,
  variant = 'row',
  last = false,
  className,
}: Readonly<RowSkeletonProps>) {
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
          {subtitle ? <Skeleton className={SUBTITLE_BAR_CLASS} /> : null}
        </View>
        <Skeleton className={META_BAR_CLASS} />
      </View>
    );
  }

  return (
    <View className={cn('min-h-[48px] flex-row items-center gap-3 px-4 py-3', className)}>
      {tile ? <Skeleton className={TILE_CLASS} /> : null}
      <View className="min-w-0 flex-1 gap-1">
        <Skeleton className={TITLE_BAR_CLASS} />
        {subtitle ? <Skeleton className={SUBTITLE_BAR_CLASS} /> : null}
      </View>
    </View>
  );
}
