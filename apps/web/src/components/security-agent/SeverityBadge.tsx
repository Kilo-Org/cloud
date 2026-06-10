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
    className: 'bg-red-500/20 text-red-400 ring-1 ring-red-500/20',
  },
  high: {
    label: 'High',
    className: 'bg-orange-500/20 text-orange-400 ring-1 ring-orange-500/20',
  },
  medium: {
    label: 'Medium',
    className: 'bg-yellow-500/20 text-yellow-400 ring-1 ring-yellow-500/20',
  },
  low: {
    label: 'Low',
    className: 'bg-blue-500/20 text-blue-400 ring-1 ring-blue-500/20',
  },
} as const;

export function SeverityBadge({ severity, size = 'md', className }: SeverityBadgeProps) {
  const config = severityConfig[severity];
  return (
    <Badge
      className={cn(
        'border-0 font-medium',
        config.className,
        size === 'sm' ? 'px-2 py-0 text-xs' : 'px-2 py-0.5 text-xs',
        className
      )}
    >
      {config.label}
    </Badge>
  );
}
