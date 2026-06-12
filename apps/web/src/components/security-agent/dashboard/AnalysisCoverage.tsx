'use client';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import Link from 'next/link';

type AnalysisData = {
  total: number;
  analyzed: number;
  exploitable: number;
  notExploitable: number;
  triageComplete: number;
  safeToDismiss: number;
  needsReview: number;
  analyzing: number;
  notAnalyzed: number;
  failed: number;
};

type AnalysisCoverageProps = {
  analysis: AnalysisData;
  isLoading: boolean;
  basePath: string;
  extraParams?: string;
};

type OutcomeItem = {
  label: string;
  count: number;
  filter: string;
  dotClass: string;
  animate?: boolean;
};

function buildOutcomeItems(analysis: AnalysisData): OutcomeItem[] {
  const items: OutcomeItem[] = [
    {
      label: 'Exploitable',
      count: analysis.exploitable,
      filter: 'exploitable',
      dotClass: 'bg-red-400',
    },
    {
      label: 'Not exploitable',
      count: analysis.notExploitable,
      filter: 'not_exploitable',
      dotClass: 'bg-green-400',
    },
    {
      label: 'Triage complete',
      count: analysis.triageComplete,
      filter: 'triage_complete',
      dotClass: 'bg-blue-400',
    },
    {
      label: 'Safe to dismiss',
      count: analysis.safeToDismiss,
      filter: 'safe_to_dismiss',
      dotClass: 'bg-zinc-400',
    },
    {
      label: 'Needs review',
      count: analysis.needsReview,
      filter: 'needs_review',
      dotClass: 'bg-orange-400',
    },
    {
      label: 'Analyzing',
      count: analysis.analyzing,
      filter: 'analyzing',
      dotClass: 'bg-yellow-400',
      animate: true,
    },
    {
      label: 'Not analyzed',
      count: analysis.notAnalyzed,
      filter: 'not_analyzed',
      dotClass: 'bg-zinc-500',
    },
    { label: 'Failed', count: analysis.failed, filter: 'failed', dotClass: 'bg-red-500' },
  ];
  return items.filter(item => item.count > 0);
}

export function AnalysisCoverage({
  analysis,
  isLoading,
  basePath,
  extraParams = '',
}: AnalysisCoverageProps) {
  const progressPct =
    analysis.total > 0 ? Math.round((analysis.analyzed / analysis.total) * 100) : 0;
  const outcomeItems = buildOutcomeItems(analysis);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-medium">Analysis coverage</CardTitle>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="space-y-4">
            <Skeleton className="h-4 w-48" />
            <Skeleton className="h-2 w-full" />
            <div className="space-y-2">
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-full" />
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="space-y-2">
              <div className="flex items-baseline justify-between">
                <span className="text-foreground text-sm">
                  <span className="font-mono font-semibold tabular-nums">{analysis.analyzed}</span>
                  <span className="text-muted-foreground">
                    {' '}
                    of {analysis.total} findings analyzed
                  </span>
                </span>
                <span className="text-muted-foreground font-mono text-xs tabular-nums">
                  {progressPct}%
                </span>
              </div>
              <Progress value={progressPct} className="bg-muted" indicatorClassName="bg-chart-2" />
            </div>

            {outcomeItems.length > 0 ? (
              <div className="space-y-1.5">
                {outcomeItems.map(item => (
                  <Link
                    key={item.filter}
                    href={`${basePath}/findings?outcomeFilter=${item.filter}${extraParams}`}
                    className="hover:bg-muted focus-visible:ring-ring flex items-center justify-between rounded-md px-2 py-1 text-sm transition-colors focus-visible:ring-2 focus-visible:outline-none"
                  >
                    <span className="flex items-center gap-2">
                      <span
                        className={cn(
                          'h-2 w-2 rounded-full',
                          item.dotClass,
                          item.animate && 'animate-pulse motion-reduce:animate-none'
                        )}
                      />
                      <span className="text-foreground">{item.label}</span>
                    </span>
                    <span className="text-muted-foreground font-mono font-medium tabular-nums">
                      {item.count}
                    </span>
                  </Link>
                ))}
              </div>
            ) : (
              <span className="text-muted-foreground text-sm">
                No findings analyzed yet. Open a finding to start triage.
              </span>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
