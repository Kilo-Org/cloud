'use client';

import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { AlertCircle, AlertTriangle, ShieldAlert, Info } from 'lucide-react';
import Link from 'next/link';

type Severity = 'critical' | 'high' | 'medium' | 'low';

type SeverityBreakdownProps = {
  severity: Record<Severity, number>;
  isLoading: boolean;
  basePath: string;
  extraParams?: string;
};

const severityConfig: Record<
  Severity,
  {
    label: string;
    icon: React.ReactNode;
    iconBgColor: string;
    iconColor: string;
    valueColor: string;
  }
> = {
  critical: {
    label: 'Critical',
    icon: <AlertCircle className="h-5 w-5" />,
    iconBgColor: 'bg-red-500/20',
    iconColor: 'text-red-400',
    valueColor: 'text-foreground',
  },
  high: {
    label: 'High',
    icon: <AlertTriangle className="h-5 w-5" />,
    iconBgColor: 'bg-orange-500/20',
    iconColor: 'text-orange-400',
    valueColor: 'text-foreground',
  },
  medium: {
    label: 'Medium',
    icon: <ShieldAlert className="h-5 w-5" />,
    iconBgColor: 'bg-yellow-500/20',
    iconColor: 'text-yellow-400',
    valueColor: 'text-foreground',
  },
  low: {
    label: 'Low',
    icon: <Info className="h-5 w-5" />,
    iconBgColor: 'bg-blue-500/20',
    iconColor: 'text-blue-400',
    valueColor: 'text-foreground',
  },
};

const severities: Severity[] = ['critical', 'high', 'medium', 'low'];

export function SeverityBreakdown({
  severity,
  isLoading,
  basePath,
  extraParams = '',
}: SeverityBreakdownProps) {
  return (
    <div className="grid h-full grid-cols-2 gap-3">
      {severities.map(sev => {
        const config = severityConfig[sev];
        return (
          <Link
            key={sev}
            href={`${basePath}/findings?severity=${sev}&status=open${extraParams}`}
            className="group flex"
          >
            <div className="relative flex flex-1 flex-col items-center justify-center overflow-hidden rounded-lg border border-gray-800 bg-gray-900/50 p-6 transition-all group-hover:border-gray-700 group-hover:bg-gray-900/70">
              <div
                className={cn(
                  'mb-3 flex h-12 w-12 items-center justify-center rounded-xl',
                  config.iconBgColor
                )}
              >
                <div className={config.iconColor}>{config.icon}</div>
              </div>
              <span className="text-muted-foreground text-sm font-medium">{config.label}</span>
              {isLoading ? (
                <Skeleton className="mt-1 h-9 w-14" />
              ) : (
                <span className={cn('text-4xl font-bold', config.valueColor)}>{severity[sev]}</span>
              )}
            </div>
          </Link>
        );
      })}
    </div>
  );
}
