import React from 'react';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

interface BooleanBadgeProps {
  /** Whether this represents a positive/true state (green) or negative/false state (red) */
  positive: boolean;
  /** Additional CSS classes to apply */
  className?: string;
  /** The content to display inside the badge */
  children: React.ReactNode;
}

/**
 * A reusable boolean badge component that displays content with consistent green/red styling
 * for true/false states. Provides excellent dark mode support.
 *
 * @example
 * ```tsx
 * <BooleanBadge positive={true}>+$50.00</BooleanBadge>
 * <BooleanBadge positive={false}>-$25.00</BooleanBadge>
 * <BooleanBadge positive={user.isActive}>Active</BooleanBadge>
 * ```
 */
export function BooleanBadge({ positive, className, children }: BooleanBadgeProps) {
  return (
    <Badge
      variant="outline"
      className={cn(
        'text-xs font-medium',
        positive
          ? 'border-green-600 bg-green-950/50 text-green-400'
          : 'border-red-600 bg-red-950/50 text-red-400',
        className
      )}
    >
      {children}
    </Badge>
  );
}
