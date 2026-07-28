'use client';

import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import Link from 'next/link';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { useTRPC } from '@/lib/trpc/utils';

function seconds(value: number): string {
  if (value < 60) return `${value.toLocaleString()}s`;
  const hours = value / 3_600;
  return hours < 1 ? `${(value / 60).toFixed(1)}m` : `${hours.toFixed(1)}h`;
}

function Metric({
  label,
  value,
  detail,
  href,
  linkLabel,
}: {
  label: string;
  value: string;
  detail: string;
  href?: string;
  linkLabel?: string;
}) {
  return (
    <div className="bg-surface-inset rounded-lg border border-border p-4">
      <p className="text-muted-foreground type-label">{label}</p>
      {href ? (
        <Link
          href={href}
          className="mt-1 block rounded-sm text-xl font-semibold tabular-nums text-link underline decoration-current/40 underline-offset-4 outline-none hover:text-link-hover focus-visible:ring-2 focus-visible:ring-ring"
          aria-label={linkLabel}
        >
          {value}
        </Link>
      ) : (
        <p className="mt-1 text-xl font-semibold tabular-nums">{value}</p>
      )}
      <p className="text-muted-foreground mt-1 type-label">{detail}</p>
    </div>
  );
}

export default function BillingHealthContent() {
  const trpc = useTRPC();
  const health = useQuery(
    trpc.admin.cloudBillingSkus.usageHealth.queryOptions(undefined, {
      staleTime: 60_000,
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
    })
  );
  const data = health.data;

  if (health.isError) {
    return (
      <Alert variant="destructive">
        <AlertTitle>Billing health could not be loaded</AlertTitle>
        <AlertDescription className="space-y-3">
          <p>{health.error.message}</p>
          <Button variant="outline" size="sm" onClick={() => void health.refetch()}>
            Retry
          </Button>
        </AlertDescription>
      </Alert>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-start">
        <div>
          <h2 className="type-heading">Accounting health</h2>
          <p className="text-muted-foreground mt-1 type-body">
            Metering-path indicators for the last 24 hours and current open intervals.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          disabled={health.isFetching}
          onClick={() => void health.refetch()}
        >
          <RefreshCw
            className={
              health.isFetching ? 'size-4 animate-spin motion-reduce:animate-none' : 'size-4'
            }
          />
          {health.isFetching ? 'Refreshing...' : 'Refresh'}
        </Button>
      </div>

      {data && (data.staleOpenIntervals > 0 || data.unconfirmedIntervalsWithRecentActivity > 0) && (
        <Alert variant="destructive">
          <AlertTriangle className="size-4" />
          <AlertTitle>Metering anomalies need attention</AlertTitle>
          <AlertDescription>
            {data.staleOpenIntervals} open interval
            {data.staleOpenIntervals === 1 ? '' : 's'} have not reported for more than 15 minutes;{' '}
            {data.unconfirmedIntervalsWithRecentActivity} unconfirmed interval
            {data.unconfirmedIntervalsWithRecentActivity === 1 ? '' : 's'} had final activity in the
            last 24 hours.
          </AlertDescription>
        </Alert>
      )}

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4" aria-busy={health.isLoading}>
        <Metric
          label="Accepted usage"
          value={data ? seconds(data.acceptedSeconds) : '—'}
          detail={data ? `${data.segments.toLocaleString()} segments received` : 'Loading…'}
        />
        <Metric
          label="Reported usage"
          value={data ? seconds(data.reportedSeconds) : '—'}
          detail={
            data ? `${seconds(data.clippedSeconds)} clipped by receive-time caps` : 'Loading…'
          }
        />
        <Metric
          label="Intervals reported"
          value={data ? data.intervalsReported.toLocaleString() : '—'}
          detail="Distinct intervals with segments in the last 24 hours"
        />
        <Metric
          label="Open now"
          value={data ? data.openIntervals.toLocaleString() : '—'}
          detail={data ? `${data.staleOpenIntervals} stale beyond 15 minutes` : 'Loading…'}
        />
        <Metric
          label="Closed after recent activity"
          value={data ? data.closedIntervalsWithRecentActivity.toLocaleString() : '—'}
          detail="Final activity occurred in the last 24 hours"
        />
        <Metric
          label="Unconfirmed"
          value={data ? data.unconfirmedIntervalsWithRecentActivity.toLocaleString() : '—'}
          detail="Final activity occurred in the last 24 hours"
          href="/admin/cloud-billing-skus?tab=usage-records&closeReason=unconfirmed"
          linkLabel={`View ${data?.unconfirmedIntervalsWithRecentActivity ?? 0} unconfirmed usage intervals`}
        />
        <Metric
          label="Clipped segments"
          value={data ? data.clippedSegments.toLocaleString() : '—'}
          detail="Reported seconds exceeded meter-observed time"
        />
        <Metric
          label="Generated"
          value={data ? new Date(data.generatedAt).toLocaleTimeString() : '—'}
          detail="Snapshot refresh time"
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Closure outcomes</CardTitle>
          <CardDescription>
            Closed intervals grouped by reason when final activity occurred in the last 24 hours.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {!data ? (
            <p className="text-muted-foreground type-body">Loading closure outcomes…</p>
          ) : data.closeReasonsByLastActivity.length === 0 ? (
            <p className="text-muted-foreground type-body">
              No closed intervals had final activity in this period.
            </p>
          ) : (
            <div className="overflow-x-auto rounded-lg border border-border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Reason</TableHead>
                    <TableHead className="text-right">Intervals</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.closeReasonsByLastActivity.map(row => (
                    <TableRow key={row.reason}>
                      <TableCell className="type-code">{row.reason}</TableCell>
                      <TableCell className="text-right tabular-nums type-code">
                        {row.count.toLocaleString()}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
      {data && (
        <p className="text-muted-foreground type-label">
          Window: {new Date(data.periodStart).toLocaleString()} to{' '}
          {new Date(data.generatedAt).toLocaleString()}. Segment metrics use meter receive time.
        </p>
      )}
    </div>
  );
}
