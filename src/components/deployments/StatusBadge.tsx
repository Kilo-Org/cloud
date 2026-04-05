import { Badge } from '@/components/ui/badge';
import { CheckCircle, Clock, XCircle, Ban, CircleDashed } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { BuildStatus } from '@/lib/user-deployments/types';

type StatusBadgeProps = {
  status: BuildStatus | null | undefined;
  className?: string;
};

const statusConfig: Record<
  BuildStatus,
  {
    label: string;
    icon: typeof Clock;
    className: string;
  }
> = {
  queued: {
    label: 'Queued',
    icon: Clock,
    className: 'bg-blue-600/20 text-blue-400 border-blue-600/30',
  },
  building: {
    label: 'Building',
    icon: Clock,
    className: 'bg-yellow-600/20 text-yellow-400 border-yellow-600/30',
  },
  deploying: {
    label: 'Deploying',
    icon: Clock,
    className: 'bg-orange-600/20 text-orange-400 border-orange-600/30',
  },
  deployed: {
    label: 'Deployed',
    icon: CheckCircle,
    className: 'bg-green-600/20 text-green-400 border-green-600/30',
  },
  failed: {
    label: 'Failed',
    icon: XCircle,
    className: 'bg-red-600/20 text-red-400 border-red-600/30',
  },
  cancelled: {
    label: 'Cancelled',
    icon: Ban,
    className: 'bg-gray-600/20 text-gray-400 border-gray-600/30',
  },
};

const fallbackConfig = {
  label: 'Unknown',
  icon: CircleDashed,
  className: 'bg-gray-600/20 text-gray-400 border-gray-600/30',
};

export function StatusBadge({ status, className }: StatusBadgeProps) {
  const config = (status && statusConfig[status]) || fallbackConfig;
  const Icon = config.icon;

  return (
    <Badge className={cn(config.className, className)} aria-label={`Status: ${config.label}`}>
      <Icon className="size-3" />
      {config.label}
    </Badge>
  );
}
