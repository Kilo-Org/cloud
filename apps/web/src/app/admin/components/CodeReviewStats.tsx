'use client';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

type StatsData = {
  totalReviews: number;
  retryAccountingMode?: 'final_outcome' | 'all_attempts';
  completedCount: number;
  failedCount: number;
  cancelledCount: number;
  interruptedCount: number;
  inProgressCount: number;
  billingErrorCount: number;
  billingRate: number;
  successRate: number;
  failureRate: number;
  cancelledRate: number;
  avgDurationSeconds: number;
};

export function CodeReviewStats({ data }: { data: StatsData }) {
  const formatDuration = (seconds: number) => {
    if (seconds === 0) return '-';
    if (seconds < 60) return `${Math.round(seconds)}s`;
    if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
    return `${(seconds / 3600).toFixed(1)}h`;
  };

  const unitLabel = data.retryAccountingMode === 'all_attempts' ? 'attempts' : 'reviews';
  const completedDescription = `${data.completedCount.toLocaleString()} completed ${unitLabel}`;

  return (
    <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-7">
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium">
            {data.retryAccountingMode === 'all_attempts' ? 'Total Attempts' : 'Total Reviews'}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-3xl font-bold">{data.totalReviews.toLocaleString()}</div>
          <div className="text-muted-foreground mt-2 text-xs">{unitLabel}</div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium">Success Rate</CardTitle>
          <CardDescription>{completedDescription}</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="text-3xl font-bold text-green-600">{data.successRate.toFixed(1)}%</div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium">Failure Rate</CardTitle>
          <CardDescription>
            {data.failedCount.toLocaleString()} failed, {data.interruptedCount.toLocaleString()}{' '}
            interrupted
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="text-3xl font-bold text-red-600">{data.failureRate.toFixed(1)}%</div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium">Cancelled Rate</CardTitle>
          <CardDescription>{data.cancelledCount.toLocaleString()} cancelled</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="text-3xl font-bold text-yellow-500">{data.cancelledRate.toFixed(1)}%</div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium">Billing Errors</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-3xl font-bold tabular-nums text-orange-500">
            {data.billingRate.toFixed(1)}%
          </div>
          <div className="text-muted-foreground mt-1 text-xs tabular-nums">
            {data.billingErrorCount.toLocaleString()} billing errors
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium">Avg Run Time</CardTitle>
          <CardDescription>Completed {unitLabel}, excludes queue wait</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="text-3xl font-bold">{formatDuration(data.avgDurationSeconds)}</div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium">In Progress</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-3xl font-bold tabular-nums text-blue-600">
            {data.inProgressCount.toLocaleString()}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
