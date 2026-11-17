import { Fragment, type ReactNode } from 'react';
import { View } from 'react-native';

import { cn } from '@/lib/utils';

/**
 * A separator starts where the row's text starts: after the 14pt gutter, the
 * 30pt tile and the 10.5pt gap. A group without tiles insets to the gutter.
 */
const SEPARATOR_AFTER_TILE_CLASS = 'ms-[54.5px]';

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
