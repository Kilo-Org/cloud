import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';

type DetailRowProps = {
  label: ReactNode;
  value: ReactNode;
  className?: string;
  /** Apply tabular-nums to the value (use for currency, dates, counts). */
  numeric?: boolean;
};

/**
 * Standard label-over-value row used across subscription detail surfaces.
 * Pairs a muted label with a foreground value, optionally tabular for numbers.
 */
export function DetailRow({ label, value, className, numeric = false }: DetailRowProps) {
  return (
    <div className={cn('space-y-1', className)}>
      <div className="text-muted-foreground text-sm">{label}</div>
      <div className={cn('font-medium break-words', numeric && 'tabular-nums')}>{value}</div>
    </div>
  );
}
