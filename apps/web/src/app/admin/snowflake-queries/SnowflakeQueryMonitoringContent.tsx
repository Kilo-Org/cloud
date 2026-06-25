'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { inferRouterOutputs } from '@trpc/server';
import { AlertCircle, Loader2, RefreshCw } from 'lucide-react';
import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { useTRPC } from '@/lib/trpc/utils';
import type { RootRouter } from '@/routers/root-router';

type RouterOutputs = inferRouterOutputs<RootRouter>;
type Overview = RouterOutputs['admin']['snowflakeQueryMonitoring']['getOverview'];
type SeriesPoint = Overview['series'][number];

type Period = '1h' | '24h' | '7d' | '30d';
type Bucket = 'hour' | 'day';

type PeriodOption = {
  value: Period;
  label: string;
  durationMs: number;
  bucket: Bucket;
};

const PERIOD_OPTIONS = [
  { value: '1h', label: 'Last hour', durationMs: 60 * 60 * 1000, bucket: 'hour' },
  { value: '24h', label: 'Last 24 hours', durationMs: 24 * 60 * 60 * 1000, bucket: 'hour' },
  { value: '7d', label: 'Last 7 days', durationMs: 7 * 24 * 60 * 60 * 1000, bucket: 'hour' },
  { value: '30d', label: 'Last 30 days', durationMs: 30 * 24 * 60 * 60 * 1000, bucket: 'day' },
] satisfies ReadonlyArray<PeriodOption>;

const utcTime = new Intl.DateTimeFormat('en-US', {
  timeZone: 'UTC',
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

function intervalForPeriod(period: Period) {
  const option = PERIOD_OPTIONS.find(candidate => candidate.value === period) ?? PERIOD_OPTIONS[1];
  const endDate = new Date();
  return {
    startDate: new Date(endDate.getTime() - option.durationMs).toISOString(),
    endDate: endDate.toISOString(),
    bucket: option.bucket,
  };
}

function isPeriod(value: string): value is Period {
  return PERIOD_OPTIONS.some(option => option.value === value);
}

function formatDuration(durationMs: number): string {
  if (durationMs < 1_000) return `${Math.round(durationMs)} ms`;
  if (durationMs < 60_000) return `${(durationMs / 1_000).toFixed(1)} s`;
  return `${(durationMs / 60_000).toFixed(1)} min`;
}

function formatBucket(bucketStart: string, period: Period): string {
  const date = new Date(bucketStart);
  if (period === '30d') {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: 'UTC',
      month: 'short',
      day: 'numeric',
    }).format(date);
  }
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(date);
}

function MetricCard({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <Card>
      <CardHeader className="gap-1 pb-3">
        <CardDescription>{label}</CardDescription>
        <CardTitle className="type-title tabular-nums">{value}</CardTitle>
      </CardHeader>
      <CardContent className="text-muted-foreground type-label">{detail}</CardContent>
    </Card>
  );
}

function DashboardSkeleton() {
  return (
    <div className="flex flex-col gap-6" role="status" aria-label="Loading Snowflake query metrics">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {Array.from({ length: 6 }, (_, index) => (
          <Skeleton key={index} className="h-32" />
        ))}
      </div>
      <Skeleton className="h-96" />
      <Skeleton className="h-72" />
    </div>
  );
}

function QueryTrendChart({ data, period }: { data: SeriesPoint[]; period: Period }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Query volume and latency</CardTitle>
        <CardDescription>
          Logical query outcomes and average end-to-end duration in UTC buckets. Edge buckets may be
          partial.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div
          className="h-80 w-full"
          role="img"
          aria-label="Snowflake query outcomes and average duration over time"
        >
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={data} margin={{ top: 8, right: 8, left: -8, bottom: 8 }}>
              <CartesianGrid strokeDasharray="3 3" className="stroke-border" vertical={false} />
              <XAxis
                dataKey="bucketStart"
                tickFormatter={value => formatBucket(String(value), period)}
                minTickGap={32}
                tick={{ fontSize: 11 }}
              />
              <YAxis yAxisId="queries" allowDecimals={false} width={42} tick={{ fontSize: 11 }} />
              <YAxis
                yAxisId="duration"
                orientation="right"
                width={58}
                tickFormatter={value => formatDuration(Number(value))}
                tick={{ fontSize: 11 }}
              />
              <Tooltip
                labelFormatter={value => `${utcTime.format(new Date(String(value)))} UTC`}
                formatter={(value, name) => [
                  name === 'Average duration'
                    ? formatDuration(Number(value))
                    : Number(value).toLocaleString(),
                  name,
                ]}
              />
              <Legend wrapperStyle={{ fontSize: '12px' }} />
              <Bar
                yAxisId="queries"
                dataKey="succeededQueries"
                stackId="queries"
                name="Succeeded"
                fill="var(--chart-2)"
              />
              <Bar
                yAxisId="queries"
                dataKey="failedQueries"
                stackId="queries"
                name="Failed"
                fill="var(--chart-5)"
              />
              <Line
                yAxisId="duration"
                dataKey="averageDurationMs"
                name="Average duration"
                type="monotone"
                stroke="var(--chart-1)"
                strokeWidth={2}
                dot={false}
              />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      </CardContent>
    </Card>
  );
}

function QueryBreakdown({ rows }: { rows: Overview['breakdown'] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Queries by caller</CardTitle>
        <CardDescription>
          Per-query fan-out, latency, failures, retries, and rate limiting for the selected period.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="overflow-x-auto rounded-lg border">
          <Table>
            <TableCaption className="sr-only">Snowflake metrics grouped by caller.</TableCaption>
            <TableHeader>
              <TableRow>
                <TableHead>Caller</TableHead>
                <TableHead className="text-right">Queries</TableHead>
                <TableHead className="text-right">Failed</TableHead>
                <TableHead className="text-right">Avg / P95</TableHead>
                <TableHead className="text-right">Requests/query</TableHead>
                <TableHead className="text-right">Retries</TableHead>
                <TableHead className="text-right">429s</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={7} className="text-muted-foreground py-8 text-center">
                    No Snowflake queries were recorded in this period.
                  </TableCell>
                </TableRow>
              ) : (
                rows.map(row => (
                  <TableRow key={`${row.source}:${row.queryLabel}`}>
                    <TableCell>
                      <div className="flex flex-col gap-1">
                        <span className="font-mono text-xs">{row.queryLabel}</span>
                        <span className="text-muted-foreground type-label">{row.source}</span>
                      </div>
                    </TableCell>
                    <TableCell className="text-right font-mono tabular-nums">
                      {row.queryCount.toLocaleString()}
                    </TableCell>
                    <TableCell className="text-right font-mono tabular-nums">
                      {row.failedQueries.toLocaleString()}
                    </TableCell>
                    <TableCell className="text-right font-mono text-xs tabular-nums whitespace-nowrap">
                      {formatDuration(row.averageDurationMs)} / {formatDuration(row.p95DurationMs)}
                    </TableCell>
                    <TableCell className="text-right font-mono tabular-nums">
                      {(row.requestCount / row.queryCount).toFixed(1)}
                    </TableCell>
                    <TableCell className="text-right font-mono tabular-nums">
                      {row.retryCount.toLocaleString()}
                    </TableCell>
                    <TableCell className="text-right font-mono tabular-nums">
                      {row.http429Count.toLocaleString()}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}

function RecentFailures({ rows }: { rows: Overview['recentFailures'] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Recent failures</CardTitle>
        <CardDescription>
          The 25 newest failed logical queries in the selected period.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="overflow-x-auto rounded-lg border">
          <Table>
            <TableCaption className="sr-only">Recent failed Snowflake queries.</TableCaption>
            <TableHeader>
              <TableRow>
                <TableHead>Time (UTC)</TableHead>
                <TableHead>Query</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Error</TableHead>
                <TableHead className="text-right">Duration</TableHead>
                <TableHead className="text-right">Retries / 429s</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="text-muted-foreground py-8 text-center">
                    No failed Snowflake queries were recorded in this period.
                  </TableCell>
                </TableRow>
              ) : (
                rows.map(row => (
                  <TableRow key={row.id}>
                    <TableCell className="font-mono text-xs whitespace-nowrap">
                      {utcTime.format(new Date(row.createdAt))}
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-col gap-1">
                        <span className="font-mono text-xs">{row.queryLabel}</span>
                        <span className="text-muted-foreground type-label">{row.source}</span>
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge variant="destructive">
                        {row.statusCode === null ? 'No response' : `HTTP ${row.statusCode}`}
                      </Badge>
                    </TableCell>
                    <TableCell className="max-w-md">
                      <div className="flex flex-col gap-1">
                        <span className="font-mono text-xs">{row.errorCode ?? 'UNCLASSIFIED'}</span>
                        <span className="text-muted-foreground line-clamp-2 text-xs">
                          {row.errorMessage ?? 'No error details recorded'}
                        </span>
                      </div>
                    </TableCell>
                    <TableCell className="text-right font-mono text-xs tabular-nums whitespace-nowrap">
                      {formatDuration(row.durationMs)}
                    </TableCell>
                    <TableCell className="text-right font-mono tabular-nums">
                      {row.retryCount} / {row.http429Count}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}

export function SnowflakeQueryMonitoringContent() {
  const trpc = useTRPC();
  const [period, setPeriod] = useState<Period>('24h');
  const [interval, setInterval] = useState(() => intervalForPeriod('24h'));
  const overview = useQuery({
    ...trpc.admin.snowflakeQueryMonitoring.getOverview.queryOptions(interval),
    refetchOnWindowFocus: false,
  });

  function updatePeriod(value: string) {
    if (!isPeriod(value)) return;
    setPeriod(value);
    setInterval(intervalForPeriod(value));
  }

  function refresh() {
    setInterval(intervalForPeriod(period));
  }

  const summary = overview.data?.summary;
  const requestsPerQuery =
    summary && summary.queryCount > 0 ? summary.requestCount / summary.queryCount : 0;

  return (
    <div className="flex w-full min-w-0 flex-col gap-6">
      <div className="flex flex-col justify-between gap-4 md:flex-row md:items-end">
        <div className="flex flex-col gap-1">
          <h1 className="type-title">Snowflake query monitoring</h1>
          <p className="text-muted-foreground type-body max-w-2xl">
            App-side SQL API health across logical queries, retries, polling, partitions, and rate
            limiting.
          </p>
        </div>
        <div className="flex w-full items-end gap-2 sm:w-auto">
          <div className="flex flex-1 flex-col gap-2 sm:min-w-48">
            <Label htmlFor="snowflake-query-period">Period</Label>
            <Select value={period} onValueChange={updatePeriod}>
              <SelectTrigger id="snowflake-query-period" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PERIOD_OPTIONS.map(option => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button variant="outline" onClick={refresh} disabled={overview.isFetching}>
            <RefreshCw className={overview.isFetching ? 'animate-spin' : ''} />
            Refresh
          </Button>
        </div>
      </div>

      <p className="text-muted-foreground type-label">
        Query logs are retained for 30 days. Metrics exclude SQL text and bindings.
      </p>

      {overview.error && (
        <Alert variant="destructive">
          <AlertCircle />
          <AlertTitle>Could not load Snowflake query metrics</AlertTitle>
          <AlertDescription>{overview.error.message}</AlertDescription>
        </Alert>
      )}

      {overview.isFetching && !overview.isLoading && (
        <div className="text-muted-foreground flex items-center gap-2 text-sm" role="status">
          <Loader2 className="size-4 animate-spin" /> Refreshing query metrics...
        </div>
      )}

      {overview.isLoading ? (
        <DashboardSkeleton />
      ) : overview.data && summary ? (
        <>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            <MetricCard
              label="Logical queries"
              value={summary.queryCount.toLocaleString()}
              detail={`${summary.succeededQueries.toLocaleString()} succeeded`}
            />
            <MetricCard
              label="Failure rate"
              value={`${(summary.failureRate * 100).toFixed(1)}%`}
              detail={`${summary.failedQueries.toLocaleString()} failed queries`}
            />
            <MetricCard
              label="P95 duration"
              value={formatDuration(summary.p95DurationMs)}
              detail={`${formatDuration(summary.averageDurationMs)} average`}
            />
            <MetricCard
              label="Requests per query"
              value={requestsPerQuery.toFixed(1)}
              detail={`${summary.requestCount.toLocaleString()} submit, poll, and partition requests`}
            />
            <MetricCard
              label="Retries"
              value={summary.retryCount.toLocaleString()}
              detail={`${summary.http202Count.toLocaleString()} pending responses`}
            />
            <MetricCard
              label="HTTP 429 responses"
              value={summary.http429Count.toLocaleString()}
              detail={`${summary.partitionCount.toLocaleString()} result partitions observed`}
            />
          </div>
          <QueryTrendChart data={overview.data.series} period={period} />
          <QueryBreakdown rows={overview.data.breakdown} />
          <RecentFailures rows={overview.data.recentFailures} />
        </>
      ) : null}
    </div>
  );
}
