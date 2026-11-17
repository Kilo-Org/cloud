import { type ReactNode } from 'react';
import { View, type ViewProps } from 'react-native';

import { cn } from '@/lib/utils';

type CardProps = ViewProps & {
  /**
   * `default` is the padded block. `none` is a bare surface for full-bleed
   * layered content: the layers own their insets, and the surface clips them to
   * its radius, so it carries neither the block padding nor the inner gap.
   */
  padding?: 'default' | 'none';
  /**
   * Non-surface layout only: width, a stacking direction, a minimum height.
   * Never another background, radius, border or padding.
   */
  className?: string;
  children: ReactNode;
};

/** A content block (balance, metric, form, info): one surface, inner `gap-3`, never nested. */
export function Card({ className, children, padding = 'default', ...props }: Readonly<CardProps>) {
  return (
    <View
      {...props}
      className={cn(
        'rounded-xl bg-secondary',
        padding === 'none' ? 'overflow-hidden' : 'gap-3 p-4',
        className
      )}
    >
      {children}
    </View>
  );
}
