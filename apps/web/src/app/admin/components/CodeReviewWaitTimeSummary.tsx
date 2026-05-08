'use client';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

type WaitTimeSummaryData = {
  waitStartedCount: number;
  avgWaitSeconds: number;
  p95WaitSeconds: number;
  p99WaitSeconds: number;
  maxWaitSeconds: number;
  waitWithinFiveMinuteRate: number;
};

function formatWaitSeconds(seconds: number | undefined): string {
  if (seconds == null) return '-';
  if (seconds < 1) return '0s';
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) {
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = Math.round(seconds - minutes * 60);
    return remainingSeconds > 0 ? `${minutes}m ${remainingSeconds}s` : `${minutes}m`;
  }
  return `${(seconds / 3600).toFixed(1)}h`;
}

export function CodeReviewWaitTimeSummary({ data }: { data: WaitTimeSummaryData }) {
  const hasStartedReviews = data.waitStartedCount > 0;
  const startedReviewText = hasStartedReviews
    ? `${data.waitStartedCount.toLocaleString()} started reviews`
    : 'No started reviews';

  return (
    <div className="grid gap-4 md:grid-cols-3">
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium">Avg Wait</CardTitle>
          <CardDescription>{startedReviewText}</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="text-3xl font-bold">
            {hasStartedReviews ? formatWaitSeconds(data.avgWaitSeconds) : '-'}
          </div>
          <p className="text-muted-foreground mt-2 text-xs">Created to started</p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium">P95 Wait</CardTitle>
          <CardDescription>
            {hasStartedReviews ? 'Started review latency' : 'No started reviews'}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="text-3xl font-bold">
            {hasStartedReviews ? formatWaitSeconds(data.p95WaitSeconds) : '-'}
          </div>
          {hasStartedReviews && (
            <div className="text-muted-foreground mt-2 space-y-0.5 text-xs">
              <div>P99: {formatWaitSeconds(data.p99WaitSeconds)}</div>
              <div>Max: {formatWaitSeconds(data.maxWaitSeconds)}</div>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium">Wait SLO</CardTitle>
          <CardDescription>Started within 5 minutes</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="text-3xl font-bold text-blue-600">
            {hasStartedReviews ? `${data.waitWithinFiveMinuteRate.toFixed(1)}%` : '-'}
          </div>
          <p className="text-muted-foreground mt-2 text-xs">{startedReviewText}</p>
        </CardContent>
      </Card>
    </div>
  );
}
