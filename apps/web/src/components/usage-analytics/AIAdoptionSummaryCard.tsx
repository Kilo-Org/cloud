'use client';

import { AlertCircle, ArrowRight, TrendingUp } from 'lucide-react';
import { useOrganizationAIAdoptionTimeseries } from '@/app/api/organizations/hooks';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { Skeleton } from '@/components/ui/skeleton';
import type { DateRange } from './hooks';

export function AIAdoptionSummaryCard({
  organizationId,
  dateRange,
  onViewDetails,
}: {
  organizationId: string;
  dateRange: DateRange;
  onViewDetails: () => void;
}) {
  const adoption = useOrganizationAIAdoptionTimeseries(
    organizationId,
    dateRange.startDate,
    dateRange.endDate
  );
  const latest = adoption.timeseries?.at(-1);
  const score = latest ? Math.round(latest.frequency + latest.depth + latest.coverage) : null;

  if (adoption.error) {
    return (
      <Card className="h-full">
        <CardContent className="flex h-full min-h-56 flex-col items-center justify-center gap-3 p-6 text-center">
          <AlertCircle className="text-muted-foreground size-5" />
          <div>
            <p className="font-medium">AI adoption score is unavailable</p>
            <p className="text-muted-foreground mt-1 text-sm">Open AI usage to try again.</p>
          </div>
          <Button variant="secondary" size="sm" onClick={onViewDetails}>
            View AI usage
            <ArrowRight className="size-4" />
          </Button>
        </CardContent>
      </Card>
    );
  }

  if (!adoption.isLoading && (adoption.isNewOrganization || score === null)) {
    return (
      <Card className="h-full">
        <CardHeader className="gap-3">
          <div className="bg-muted flex size-9 items-center justify-center rounded-lg">
            <TrendingUp className="size-4" />
          </div>
          <div className="space-y-1.5">
            <CardTitle className="text-lg">AI adoption score</CardTitle>
            <p className="text-muted-foreground text-sm">
              Frequency, depth, and coverage of AI usage.
            </p>
          </div>
        </CardHeader>
        <CardContent className="space-y-5">
          <div>
            <p className="font-medium">Not enough activity yet</p>
            <p className="text-muted-foreground mt-1 text-sm">
              The score appears after at least three days of AI usage.
            </p>
          </div>
          <Button variant="secondary" size="sm" onClick={onViewDetails}>
            View AI usage
            <ArrowRight className="size-4" />
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="h-full">
      <CardHeader className="gap-3">
        <div className="bg-muted flex size-9 items-center justify-center rounded-lg">
          <TrendingUp className="size-4" />
        </div>
        <div className="space-y-1.5">
          <CardTitle className="text-lg">AI adoption score</CardTitle>
          <p className="text-muted-foreground text-sm">
            Frequency, depth, and coverage of AI usage.
          </p>
        </div>
      </CardHeader>
      <CardContent className="space-y-5">
        {adoption.isLoading ? (
          <Skeleton className="h-12 w-28" />
        ) : (
          <div>
            <div className="text-4xl font-bold tabular-nums">{score}</div>
            <div className="text-muted-foreground text-sm">out of 100</div>
          </div>
        )}
        <Progress
          value={score}
          indicatorClassName="bg-gradient-to-r from-blue-600 via-blue-500 to-green-500"
          aria-label={`AI adoption score ${score} out of 100`}
        />
        <Button variant="secondary" size="sm" onClick={onViewDetails}>
          View AI usage
          <ArrowRight className="size-4" />
        </Button>
      </CardContent>
    </Card>
  );
}
