'use client';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

type VersionBreakdownRow = {
  agentVersion: string;
  total: number;
  completed: number;
  failed: number;
  avgDurationSeconds: number;
};

type StatsData = {
  totalReviews: number;
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
  versionBreakdown?: VersionBreakdownRow[];
};

export function CodeReviewStats({ data }: { data: StatsData }) {
  const formatDuration = (seconds: number) => {
    if (seconds === 0) return '-';
    if (seconds < 60) return `${Math.round(seconds)}s`;
    if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
    return `${(seconds / 3600).toFixed(1)}h`;
  };

  // Build a map for quick version lookup
  const byVersion = new Map<string, VersionBreakdownRow>();
  for (const row of data.versionBreakdown ?? []) {
    byVersion.set(row.agentVersion, row);
  }

  const showVersionBreakdown = byVersion.size > 0;

  return (
    <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-7">
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium">Total Reviews</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-3xl font-bold">{data.totalReviews.toLocaleString()}</div>
          {showVersionBreakdown && (
            <div className="text-muted-foreground mt-2 space-y-0.5 text-xs">
              {['v1', 'v2'].map(v => {
                const row = byVersion.get(v);
                if (!row) return null;
                return (
                  <div key={v}>
                    {v.toUpperCase()}: {row.total.toLocaleString()}
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium">Success Rate</CardTitle>
          <CardDescription>{data.completedCount.toLocaleString()} completed</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="text-3xl font-bold text-green-600">{data.successRate.toFixed(1)}%</div>
          {showVersionBreakdown && (
            <div className="text-muted-foreground mt-2 space-y-0.5 text-xs">
              {['v1', 'v2'].map(v => {
                const row = byVersion.get(v);
                if (!row) return null;
                return (
                  <div key={v}>
                    {v.toUpperCase()}: {row.completed.toLocaleString()} completed
                  </div>
                );
              })}
            </div>
          )}
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
          {showVersionBreakdown && (
            <div className="text-muted-foreground mt-2 space-y-0.5 text-xs">
              {['v1', 'v2'].map(v => {
                const row = byVersion.get(v);
                if (!row) return null;
                return (
                  <div key={v}>
                    {v.toUpperCase()}: {row.failed.toLocaleString()} failed
                  </div>
                );
              })}
            </div>
          )}
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
          <CardDescription>{data.billingRate.toFixed(1)}% of terminal outcomes</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="text-3xl font-bold text-orange-500">{data.billingErrorCount}</div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium">Avg Duration</CardTitle>
          <CardDescription>Completed reviews</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="text-3xl font-bold">{formatDuration(data.avgDurationSeconds)}</div>
          {showVersionBreakdown && (
            <div className="text-muted-foreground mt-2 space-y-0.5 text-xs">
              {['v1', 'v2'].map(v => {
                const row = byVersion.get(v);
                if (!row) return null;
                return (
                  <div key={v}>
                    {v.toUpperCase()}: {formatDuration(row.avgDurationSeconds)}
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium">In Progress</CardTitle>
          <CardDescription>Pending/Queued/Running</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="text-3xl font-bold text-blue-600">{data.inProgressCount}</div>
        </CardContent>
      </Card>
    </div>
  );
}
