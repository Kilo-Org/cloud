import type { ReactNode } from 'react';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import type { SpendMetric } from '../types';

const statusBadgeClasses = {
  neutral: 'border-border text-muted-foreground',
  success: 'border-status-success-border text-status-success',
  warning: 'border-status-warning-border text-status-warning',
  danger: 'border-status-destructive-border text-status-destructive',
} satisfies Record<SpendMetric['tone'], string>;

export function StatusBadge({
  children,
  tone = 'neutral',
}: {
  children: ReactNode;
  tone?: SpendMetric['tone'];
}) {
  return (
    <Badge variant="secondary-outline" className={cn('gap-1.5', statusBadgeClasses[tone])}>
      {children}
    </Badge>
  );
}
