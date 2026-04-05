'use client';

import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { AlertCircle, CheckCircle2, AlertTriangle, Shield } from 'lucide-react';
import Link from 'next/link';

type Severity = 'critical' | 'high' | 'medium' | 'low';

type SlaData = {
  overall: { total: number; withinSla: number; overdue: number };
  bySeverity: Record<Severity, { total: number; withinSla: number; overdue: number }>;
  untrackedCount: number;
};

type SlaComplianceHeroProps = {
  sla: SlaData;
  isLoading: boolean;
  basePath: string;
  extraParams?: string;
};

const severityMeta: Record<Severity, { label: string; colorClass: string; icon: React.ReactNode }> =
  {
    critical: {
      label: 'Critical',
      colorClass: 'text-red-400',
      icon: <AlertCircle className="h-4 w-4" />,
    },
    high: {
      label: 'High',
      colorClass: 'text-orange-400',
      icon: <AlertTriangle className="h-4 w-4" />,
    },
    medium: {
      label: 'Medium',
      colorClass: 'text-yellow-400',
      icon: <Shield className="h-4 w-4" />,
    },
    low: {
      label: 'Low',
      colorClass: 'text-blue-400',
      icon: <Shield className="h-4 w-4" />,
    },
  };

const severities: Severity[] = ['critical', 'high', 'medium', 'low'];

function computeCompliance(sla: SlaData) {
  if (sla.overall.total === 0) {
    if (sla.untrackedCount > 0) {
      return { label: 'N/A', hint: 'No SLA data', dotColor: 'bg-gray-400' };
    }
    return { label: '100%', hint: 'No open findings with SLA', dotColor: 'bg-green-400' };
  }
  const pct = Math.round((sla.overall.withinSla / sla.overall.total) * 100);
  const dotColor = pct >= 90 ? 'bg-green-400' : pct >= 70 ? 'bg-yellow-400' : 'bg-red-400';
  return { label: `${pct}%`, hint: null, dotColor };
}

export function SlaComplianceHero({
  sla,
  isLoading,
  basePath,
  extraParams = '',
}: SlaComplianceHeroProps) {
  if (isLoading) {
    return (
      <Card className="border border-gray-800 bg-gray-900/50">
        <CardContent className="p-6">
          <div className="flex flex-col items-center gap-4 md:flex-row md:items-start md:gap-8">
            <div className="flex flex-col items-center gap-2">
              <Skeleton className="h-16 w-32" />
              <Skeleton className="h-4 w-24" />
            </div>
            <div className="flex-1 space-y-3">
              <Skeleton className="h-5 w-full" />
              <Skeleton className="h-5 w-full" />
              <Skeleton className="h-5 w-full" />
              <Skeleton className="h-5 w-full" />
            </div>
          </div>
        </CardContent>
      </Card>
    );
  }

  const compliance = computeCompliance(sla);

  return (
    <Card className="border border-gray-800 bg-gray-900/50">
      <CardContent className="p-6">
        <div className="flex flex-col items-center gap-4 md:flex-row md:items-start md:gap-8">
          <div className="flex flex-col items-center gap-1">
            <span className="text-muted-foreground text-sm font-medium">SLA Compliance</span>
            <span className="flex items-center gap-2">
              <span className={cn('h-3 w-3 rounded-full', compliance.dotColor)} />
              <span className="text-foreground text-3xl font-bold tracking-tight">
                {compliance.label}
              </span>
            </span>
            {compliance.hint && (
              <span className="text-muted-foreground text-xs">{compliance.hint}</span>
            )}
            {sla.overall.overdue > 0 && (
              <Link
                href={`${basePath}/findings?status=open&overdue=true${extraParams}`}
                className="mt-1 flex items-center gap-1 text-sm text-red-400 hover:text-red-300"
              >
                <AlertCircle className="h-3.5 w-3.5" />
                {sla.overall.overdue} overdue
              </Link>
            )}
            {sla.overall.overdue === 0 && sla.overall.total > 0 && (
              <span className="mt-1 flex items-center gap-1 text-sm text-green-400">
                <CheckCircle2 className="h-3.5 w-3.5" />
                No overdue findings
              </span>
            )}
          </div>

          <div className="flex-1 space-y-2">
            <span className="text-muted-foreground text-xs font-medium tracking-wider uppercase">
              By Severity
            </span>
            {severities.map(sev => {
              const sevData = sla.bySeverity[sev];
              if (sevData.total === 0) return null;
              const sevPct = Math.round((sevData.withinSla / sevData.total) * 100);
              const meta = severityMeta[sev];
              return (
                <div key={sev} className="flex items-center gap-3 text-sm">
                  <span className="flex items-center gap-1.5">
                    <span className={meta.colorClass}>{meta.icon}</span>
                    <span className="text-muted-foreground w-16 font-medium">{meta.label}</span>
                  </span>
                  <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-gray-800">
                    <div
                      className={cn(
                        'h-full rounded-full transition-all',
                        sevPct >= 90
                          ? 'bg-emerald-500/40'
                          : sevPct >= 70
                            ? 'bg-yellow-500/40'
                            : 'bg-red-500/40'
                      )}
                      style={{ width: `${sevPct}%` }}
                    />
                  </div>
                  <span className="text-muted-foreground w-28 text-right text-xs">
                    {sevPct}% ({sevData.withinSla} of {sevData.total})
                  </span>
                </div>
              );
            })}
            {severities.every(sev => sla.bySeverity[sev].total === 0) && (
              <span className="text-muted-foreground text-sm">No severity breakdown available</span>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
