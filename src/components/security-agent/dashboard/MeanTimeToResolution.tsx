'use client';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { CheckCircle2, AlertCircle } from 'lucide-react';

type Severity = 'critical' | 'high' | 'medium' | 'low';

type MttrData = Record<
  Severity,
  {
    avgDays: number | null;
    medianDays: number | null;
    count: number;
    slaDays: number;
  }
>;

type MeanTimeToResolutionProps = {
  mttr: { bySeverity: MttrData };
  isLoading: boolean;
};

const severityMeta: Record<Severity, { label: string; dotColor: string }> = {
  critical: { label: 'Critical', dotColor: 'bg-red-400' },
  high: { label: 'High', dotColor: 'bg-orange-400' },
  medium: { label: 'Medium', dotColor: 'bg-yellow-400' },
  low: { label: 'Low', dotColor: 'bg-blue-400' },
};

const severities: Severity[] = ['critical', 'high', 'medium', 'low'];

function formatDays(days: number | null): string {
  if (days === null) return '\u2014';
  return `${days.toFixed(1)}d`;
}

export function MeanTimeToResolution({ mttr, isLoading }: MeanTimeToResolutionProps) {
  const hasAnyData = severities.some(sev => mttr.bySeverity[sev].count > 0);

  return (
    <Card className="border border-gray-800 bg-gray-900/50">
      <CardHeader>
        <CardTitle className="text-sm font-medium">Mean Time to Resolution</CardTitle>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="space-y-3">
            <Skeleton className="h-6 w-full" />
            <Skeleton className="h-6 w-full" />
            <Skeleton className="h-6 w-full" />
            <Skeleton className="h-6 w-full" />
          </div>
        ) : !hasAnyData ? (
          <div className="text-muted-foreground py-4 text-center text-sm">
            No resolution data yet
          </div>
        ) : (
          <div className="space-y-3">
            {severities.map(sev => {
              const data = mttr.bySeverity[sev];
              const meta = severityMeta[sev];
              const withinSla = data.avgDays !== null && data.avgDays <= data.slaDays;

              return (
                <div key={sev} className="flex items-center justify-between text-sm">
                  <div className="flex items-center gap-2">
                    <span className={cn('h-2 w-2 rounded-full', meta.dotColor)} />
                    <span className="text-muted-foreground w-16 font-medium">{meta.label}</span>
                    <span className="font-semibold text-white">{formatDays(data.avgDays)}</span>
                    <span className="text-muted-foreground text-xs">/ SLA: {data.slaDays}d</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-muted-foreground text-xs">{data.count} fixed</span>
                    {data.avgDays !== null &&
                      (withinSla ? (
                        <CheckCircle2 className="h-4 w-4 text-green-400" />
                      ) : (
                        <AlertCircle className="h-4 w-4 text-red-400" />
                      ))}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
