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
      label: 'Not Exploitable',
      count: analysis.notExploitable,
      filter: 'not_exploitable',
      dotClass: 'bg-green-400',
    },
    {
      label: 'Triage Complete',
      count: analysis.triageComplete,
      filter: 'triage_complete',
      dotClass: 'bg-blue-400',
    },
    {
      label: 'Safe to Dismiss',
      count: analysis.safeToDismiss,
      filter: 'safe_to_dismiss',
      dotClass: 'bg-gray-400',
    },
    {
      label: 'Needs Review',
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
      label: 'Not Analyzed',
      count: analysis.notAnalyzed,
      filter: 'not_analyzed',
      dotClass: 'bg-gray-500',
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
    <Card className="border border-gray-800 bg-gray-900/50">
      <CardHeader>
        <CardTitle className="text-sm font-medium">Analysis Coverage</CardTitle>
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
                <span className="text-sm text-white">
                  <span className="font-semibold">{analysis.analyzed}</span>
                  <span className="text-muted-foreground">
                    {' '}
                    of {analysis.total} findings analyzed
                  </span>
                </span>
                <span className="text-muted-foreground text-xs">{progressPct}%</span>
              </div>
              <Progress value={progressPct} />
            </div>

            {outcomeItems.length > 0 ? (
              <div className="space-y-1.5">
                {outcomeItems.map(item => (
                  <Link
                    key={item.filter}
                    href={`${basePath}/findings?outcomeFilter=${item.filter}${extraParams}`}
                    className="flex items-center justify-between rounded px-2 py-1 text-sm transition-colors hover:bg-gray-800/50"
                  >
                    <span className="flex items-center gap-2">
                      <span
                        className={cn(
                          'h-2 w-2 rounded-full',
                          item.dotClass,
                          item.animate && 'animate-pulse'
                        )}
                      />
                      <span className="text-gray-300">{item.label}</span>
                    </span>
                    <span className="text-muted-foreground font-medium">{item.count}</span>
                  </Link>
                ))}
              </div>
            ) : (
              <span className="text-muted-foreground text-sm">No analysis data</span>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
