'use client';

import React from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

type QueueHealthData = {
  pendingReviewCount: number;
  pendingOverFiveMinutesCount: number;
  oldestPendingAgeSeconds: number;
  staleQueuedClaimCount: number;
  runningOverNinetyMinutesCount: number;
  ownersWithWaitingReviewsCount: number;
};

function formatQueueAge(seconds: number): string {
  if (seconds <= 0) return '-';
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) {
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = Math.round(seconds - minutes * 60);
    return remainingSeconds > 0 ? `${minutes}m ${remainingSeconds}s` : `${minutes}m`;
  }
  return `${(seconds / 3600).toFixed(1)}h`;
}

export function CodeReviewQueueHealthSummary({ data }: { data: QueueHealthData }) {
  return (
    <section className="space-y-4">
      <div>
        <h3 className="text-lg font-semibold">Current queue health</h3>
        <p className="text-muted-foreground mt-1 text-sm">
          Live dispatch snapshot. Owner filters apply. Date range and retry accounting affect
          telemetry below only.
        </p>
      </div>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-6">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Pending reviews</CardTitle>
            <CardDescription>Waiting for dispatch</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold tabular-nums">
              {data.pendingReviewCount.toLocaleString()}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Pending &gt; 5m</CardTitle>
            <CardDescription>Live queue SLO signal</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold tabular-nums">
              {data.pendingOverFiveMinutesCount.toLocaleString()}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Oldest pending</CardTitle>
            <CardDescription>Created to now</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold tabular-nums">
              {data.pendingReviewCount > 0 ? formatQueueAge(data.oldestPendingAgeSeconds) : '-'}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Stale queued claims</CardTitle>
            <CardDescription>Recovery eligible</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold tabular-nums">
              {data.staleQueuedClaimCount.toLocaleString()}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Running &gt; 90m</CardTitle>
            <CardDescription>Read-only diagnostic</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold tabular-nums">
              {data.runningOverNinetyMinutesCount.toLocaleString()}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Owners waiting</CardTitle>
            <CardDescription>Pending or stale queued</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold tabular-nums">
              {data.ownersWithWaitingReviewsCount.toLocaleString()}
            </div>
          </CardContent>
        </Card>
      </div>
    </section>
  );
}
