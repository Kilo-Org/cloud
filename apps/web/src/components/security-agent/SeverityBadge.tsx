'use client';

import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

type SeverityBadgeProps = {
  severity: 'critical' | 'high' | 'medium' | 'low';
  size?: 'sm' | 'md';
  className?: string;
};

const severityConfig = {
  critical: {
    label: 'Critical',
    className: 'bg-red-500/20 text-red-400 border-red-500/30 hover:bg-red-500/30',
    icon: '🔴',
  },
  high: {
    label: 'High',
    className: 'bg-orange-500/20 text-orange-400 border-orange-500/30 hover:bg-orange-500/30',
    icon: '🟠',
  },
  medium: {
    label: 'Medium',
    className: 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30 hover:bg-yellow-500/30',
    icon: '🟡',
  },
  low: {
    label: 'Low',
    className: 'bg-blue-500/20 text-blue-400 border-blue-500/30 hover:bg-blue-500/30',
    icon: '🔵',
  },
} as const;

export function SeverityBadge({ severity, size = 'md', className }: SeverityBadgeProps) {
  const config = severityConfig[severity];

  return (
    <Badge
      variant="outline"
      className={cn(
        config.className,
        size === 'sm' ? 'px-1.5 py-0 text-xs' : 'px-2 py-0.5 text-sm',
        className
      )}
    >
      {config.label}
    </Badge>
  );
}

export function getSeverityColor(severity: 'critical' | 'high' | 'medium' | 'low'): string {
  const colors = {
    critical: 'text-red-400',
    high: 'text-orange-400',
    medium: 'text-yellow-400',
    low: 'text-blue-400',
  };
  return colors[severity];
}
