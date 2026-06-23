'use client';

import Link from 'next/link';
import { AlertCircle, AlertTriangle, Info, ShieldAlert } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

type Severity = 'critical' | 'high' | 'medium' | 'low';

type SeverityBreakdownProps = {
  severity: Record<Severity, number>;
  isLoading: boolean;
  basePath: string;
  extraParams?: string;
};

const severityConfig = {
  critical: {
    label: 'Critical',
    icon: AlertCircle,
    badgeClass: 'bg-red-500/20 text-red-400 ring-red-500/20',
  },
  high: {
    label: 'High',
    icon: AlertTriangle,
    badgeClass: 'bg-orange-500/20 text-orange-400 ring-orange-500/20',
  },
  medium: {
    label: 'Medium',
    icon: ShieldAlert,
    badgeClass: 'bg-yellow-500/20 text-yellow-400 ring-yellow-500/20',
  },
  low: {
    label: 'Low',
    icon: Info,
    badgeClass: 'bg-blue-500/20 text-blue-400 ring-blue-500/20',
  },
} satisfies Record<Severity, { label: string; icon: typeof Info; badgeClass: string }>;

const severities: Severity[] = ['critical', 'high', 'medium', 'low'];

export function SeverityBreakdown({
  severity,
  isLoading,
  basePath,
  extraParams = '',
}: SeverityBreakdownProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-medium">Open findings by severity</CardTitle>
      </CardHeader>
      <CardContent className="grid grid-cols-2 gap-2">
        {severities.map(severityKey => {
          const config = severityConfig[severityKey];
          const Icon = config.icon;
          return (
            <Link
              key={severityKey}
              href={`${basePath}/findings?severity=${severityKey}&status=open${extraParams}`}
              className="hover:bg-muted focus-visible:ring-ring flex items-center justify-between gap-3 rounded-lg border border-border bg-background p-4 transition-colors focus-visible:ring-2 focus-visible:outline-none"
            >
              <span className="flex min-w-0 items-center gap-3">
                <span
                  className={cn(
                    'flex size-8 shrink-0 items-center justify-center rounded-sm ring-1',
                    config.badgeClass
                  )}
                >
                  <Icon className="size-4" aria-hidden="true" />
                </span>
                <span className="text-muted-foreground text-sm font-medium">{config.label}</span>
              </span>
              {isLoading ? (
                <Skeleton className="h-7 w-8" />
              ) : (
                <span className="font-mono text-xl font-semibold tabular-nums">
                  {severity[severityKey]}
                </span>
              )}
            </Link>
          );
        })}
      </CardContent>
    </Card>
  );
}
