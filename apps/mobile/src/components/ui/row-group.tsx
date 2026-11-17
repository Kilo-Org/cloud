import { Fragment, type ReactNode } from 'react';
import { View } from 'react-native';

import { cn } from '@/lib/utils';

/**
 * A separator starts where the row's text starts: after the 14pt gutter, the
 * 30pt tile and the 10.5pt gap. A group without tiles insets to the gutter.
 */
const SEPARATOR_AFTER_TILE_CLASS = 'ms-[54.5px]';

/** The surface and rounded ends of a grouped item, by its place in the group. */
const GROUPED_SURFACE_CLASS = {
  only: 'rounded-xl',
  first: 'rounded-t-xl',
  middle: '',
  last: 'rounded-b-xl',
} as const;

type RowGroupProps = {
  /**
   * The rows lead with a 30pt icon tile, so every separator starts after it
   * instead of at the gutter. Leave it off for value-only rows.
   */
  leadingTile?: boolean;
  className?: string;
  children: ReactNode;
};

/**
 * The grouped settings card: one rounded surface per section, a hairline
 * between consecutive rows and none after the last. Rows never draw their own
 * divider.
 *
 * A virtualized list cannot pass its rows as one child array, so it renders
 * `RowGroupItem` per cell instead; both draw the same surface and separator.
 */
export function RowGroup({ leadingTile = false, className, children }: Readonly<RowGroupProps>) {
  const rows = (Array.isArray(children) ? children : [children])
    .flat(Infinity)
    .filter((row): row is ReactNode => row !== null && row !== undefined && row !== false);
  return (
    <View className={cn('overflow-hidden rounded-xl bg-secondary', className)}>
      {rows.map((row, index) => (
        <Fragment key={index}>
          {row}
          {index < rows.length - 1 ? (
            <View
              className={cn(
                'border-b-[0.5px] border-hair-soft',
                leadingTile ? SEPARATOR_AFTER_TILE_CLASS : 'ms-4'
              )}
            />
          ) : null}
        </Fragment>
      ))}
    </View>
  );
}

type RowGroupItemProps = {
  /**
   * Where this row sits in its section: `only` for a one-row section, `first`
   * to round the top, `middle` for any row between, `last` to round the bottom.
   * Each cell draws its own end, so a recycled list keeps the grouped look.
   */
  position: 'only' | 'first' | 'middle' | 'last';
  /** The row leads with a 30pt tile, so its separator starts after it. */
  leadingTile?: boolean;
  className?: string;
  children: ReactNode;
};

/**
 * One cell of a grouped section inside a virtualized list (`FlashList`).
 *
 * `RowGroup` draws a section's surface and separators around an array of rows;
 * a virtualized list renders its cells one at a time, so each cell carries its
 * own rounded end, surface and trailing hairline instead. The row inside stays
 * a plain row primitive with no divider of its own.
 */
export function RowGroupItem({
  position,
  leadingTile = false,
  className,
  children,
}: Readonly<RowGroupItemProps>) {
  return (
    <View
      className={cn('overflow-hidden bg-secondary', GROUPED_SURFACE_CLASS[position], className)}
    >
      {children}
      {position === 'first' || position === 'middle' ? (
        <View
          className={cn(
            'border-b-[0.5px] border-hair-soft',
            leadingTile ? SEPARATOR_AFTER_TILE_CLASS : 'ms-4'
          )}
        />
      ) : null}
    </View>
  );
}
