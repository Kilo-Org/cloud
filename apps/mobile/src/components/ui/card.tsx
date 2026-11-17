import { type ReactNode } from 'react';
import { View, type ViewProps } from 'react-native';

import { cn } from '@/lib/utils';

type CardProps = ViewProps & {
  /**
   * Non-surface layout only: width, a stacking direction, a minimum height.
   * Never another background, radius, border or padding.
   */
  className?: string;
  children: ReactNode;
};

/** A content block (balance, metric, form, info): one surface, inner `gap-3`, never nested. */
export function Card({ className, children, ...props }: Readonly<CardProps>) {
  return (
    <View {...props} className={cn('gap-3 rounded-xl bg-secondary p-4', className)}>
      {children}
    </View>
  );
}
