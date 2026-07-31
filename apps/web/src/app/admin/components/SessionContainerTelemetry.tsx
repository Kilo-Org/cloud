'use client';

import React from 'react';
import type { inferRouterOutputs } from '@trpc/server';
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

import { useAdminSessionContainerMetrics } from '@/app/admin/api/session-traces/hooks';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import type { RootRouter } from '@/routers/root-router';

type RouterOutputs = inferRouterOutputs<RootRouter>;
export type SessionContainerInfo = NonNullable<
  RouterOutputs['admin']['sessionTraces']['getContainerInfo']
>;
type SessionContainerMetrics = RouterOutputs['admin']['sessionTraces']['getContainerMetrics'];
type MetricsQueryState = {
  isLoading: boolean;
  isError: boolean;
  error?: { message: string } | null;
  data?: SessionContainerMetrics;
};

function formatBytes(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '-';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let amount = value;
  let unit = 0;
  while (amount >= 1024 && unit < units.length - 1) {
    amount /= 1024;
    unit += 1;
  }
  return `${amount >= 10 || unit === 0 ? amount.toFixed(0) : amount.toFixed(1)} ${units[unit]}`;
}

function formatPercent(value: number | null): string {
  return value === null || !Number.isFinite(value) ? '-' : `${(value * 100).toFixed(1)}%`;
}

function formatTime(value: string): string {
  return new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function SessionContainerTelemetry({
  sessionId,
  info,
}: {
  sessionId: string;
  info: SessionContainerInfo;
}) {
  const metricsQuery = useAdminSessionContainerMetrics(sessionId);
  return <SessionContainerTelemetryContent info={info} metricsQuery={metricsQuery} />;
}

export function SessionContainerTelemetryContent({
  info,
  metricsQuery,
}: {
  info: SessionContainerInfo;
  metricsQuery: MetricsQueryState;
}) {
  const metrics = metricsQuery.data;
  const rows = metrics?.available ? metrics.rows : [];
  const latestInterval = info.intervals.at(-1);
  const knownMemoryCapacities = info.intervals.flatMap(interval =>
    interval.capacity ? [interval.capacity.memoryBytes] : []
  );
  const memoryCapacities = new Set(knownMemoryCapacities);
  // A global limit is only valid when every plotted interval has the same known capacity.
  const memoryCapacity =
    knownMemoryCapacities.length === info.intervals.length && memoryCapacities.size === 1
      ? knownMemoryCapacities[0]
      : null;
  const seriesColors = [
    'var(--chart-1)',
    'var(--chart-2)',
    'var(--chart-3)',
    'var(--chart-4)',
    'var(--chart-5)',
  ];
  const placementsByWindow = new Map<string, Set<string>>();
  for (const row of rows) {
    const placements = placementsByWindow.get(row.windowKey) ?? new Set<string>();
    placements.add(row.placementId);
    placementsByWindow.set(row.windowKey, placements);
  }
  let nextSeriesIndex = 0;
  const series = [...placementsByWindow].flatMap(([windowKey, placements]) =>
    [...placements].map(placementId => {
      const seriesIndex = nextSeriesIndex;
      nextSeriesIndex += 1;
      return {
        windowKey,
        placementId,
        label:
          placementId && placementId.length > 12
            ? `${placementId.slice(0, 8)}...`
            : (placementId ?? 'unknown'),
        color: seriesColors[seriesIndex % seriesColors.length],
        memoryMaxKey: `memoryMax${seriesIndex}`,
        memoryP95Key: `memoryP95${seriesIndex}`,
        cpuAverageKey: `cpuAverage${seriesIndex}`,
        cpuP95Key: `cpuP95${seriesIndex}`,
      };
    })
  );
  const seriesByWindow = new Map<string, Map<string, (typeof series)[number]>>();
  for (const item of series) {
    const placements = seriesByWindow.get(item.windowKey) ?? new Map();
    placements.set(item.placementId, item);
    seriesByWindow.set(item.windowKey, placements);
  }
  const chartPoints = new Map<string, Record<string, string | number | null>>();
  for (const row of rows) {
    const point = chartPoints.get(row.timestamp) ?? {
      timestamp: row.timestamp,
    };
    const item = seriesByWindow.get(row.windowKey)?.get(row.placementId);
    if (item) {
      point[item.memoryMaxKey] = row.max.memory === null ? null : row.max.memory / 1024 ** 3;
      point[item.memoryP95Key] =
        row.quantiles.memoryP95 === null ? null : row.quantiles.memoryP95 / 1024 ** 3;
      point[item.cpuAverageKey] =
        row.avg.cpuUtilization === null ? null : row.avg.cpuUtilization * 100;
      point[item.cpuP95Key] =
        row.quantiles.cpuUtilizationP95 === null ? null : row.quantiles.cpuUtilizationP95 * 100;
    }
    chartPoints.set(row.timestamp, point);
  }
  const chartData = [...chartPoints.values()].sort(
    (left, right) => Date.parse(String(left.timestamp)) - Date.parse(String(right.timestamp))
  );
  const peakMemory = rows.reduce<number | null>(
    (peak, row) => (row.max.memory === null ? peak : Math.max(peak ?? 0, row.max.memory)),
    null
  );
  const peakCpuP95 = rows.reduce<number | null>(
    (peak, row) =>
      row.quantiles.cpuUtilizationP95 === null
        ? peak
        : Math.max(peak ?? 0, row.quantiles.cpuUtilizationP95),
    null
  );
  const placements = new Set(rows.map(row => row.placementId));

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle>Container Metrics</CardTitle>
            <CardDescription>
              Cloudflare workload samples for the container intervals attributed to this session
            </CardDescription>
          </div>
          <Badge variant="outline">
            {info.scope === 'isolated' ? 'Isolated container' : 'Shared container'}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-6">
        {info.scope === 'shared' && (
          <Alert>
            <AlertDescription>
              This container is shared. Workload samples may include activity from other sessions.
            </AlertDescription>
          </Alert>
        )}

        {metricsQuery.isLoading ? (
          <div className="space-y-4" role="status" aria-label="Loading container metrics">
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {Array.from({ length: 4 }, (_, index) => (
                <Skeleton key={index} className="h-16" />
              ))}
            </div>
            <Skeleton className="h-64" />
          </div>
        ) : metricsQuery.isError ? (
          <Alert variant="destructive">
            <AlertDescription>
              {metricsQuery.error?.message ?? 'Container metrics failed to load.'}
            </AlertDescription>
          </Alert>
        ) : !metrics?.available ? (
          <p className="text-muted-foreground text-sm">
            {metrics?.reason === 'no_provider_identity'
              ? 'No Cloudflare instance identity was recorded for these container intervals.'
              : metrics?.reason === 'ambiguous_application'
                ? 'Cloudflare returned more than one container application for this instance ID.'
                : metrics?.reason === 'no_container_intervals'
                  ? 'No metered container intervals were recorded for this session.'
                  : 'Container metrics are not available for this session.'}
          </p>
        ) : rows.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            No Cloudflare workload samples are available for these container intervals.
          </p>
        ) : (
          <>
            {metrics.partial && (
              <Alert>
                <AlertDescription>
                  Cloudflare returned partial metrics. {metrics.issues.join(' ')}
                </AlertDescription>
              </Alert>
            )}

            <div className="border-border grid overflow-hidden rounded-lg border sm:grid-cols-2 lg:grid-cols-4">
              <div className="p-3">
                <p className="text-muted-foreground text-xs">Peak memory</p>
                <p className="mt-1 font-mono text-sm tabular-nums">
                  {formatBytes(peakMemory)}
                  {memoryCapacity ? ` / ${formatBytes(memoryCapacity)}` : ''}
                </p>
              </div>
              <div className="border-border p-3 sm:border-l">
                <p className="text-muted-foreground text-xs">Peak CPU P95</p>
                <p className="mt-1 font-mono text-sm tabular-nums">{formatPercent(peakCpuP95)}</p>
              </div>
              <div className="border-border p-3 lg:border-l">
                <p className="text-muted-foreground text-xs">Placements</p>
                <p className="mt-1 font-mono text-sm tabular-nums">{placements.size}</p>
              </div>
              <div className="border-border p-3 sm:border-l">
                <p className="text-muted-foreground text-xs">Container intervals</p>
                <p className="mt-1 font-mono text-sm tabular-nums">{info.intervals.length}</p>
              </div>
            </div>

            <div className="grid gap-6 xl:grid-cols-2">
              <figure
                className="space-y-2"
                role="img"
                aria-label="Container memory usage over time"
              >
                <h3 className="text-sm font-medium">Memory</h3>
                <div className="h-64 w-full">
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={chartData} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                      <XAxis
                        dataKey="timestamp"
                        tick={{ fontSize: 10 }}
                        tickFormatter={value => formatTime(String(value))}
                        minTickGap={24}
                      />
                      <YAxis
                        tick={{ fontSize: 10 }}
                        tickFormatter={value => `${Number(value).toFixed(1)} GiB`}
                        width={62}
                      />
                      <Tooltip
                        formatter={(value, name) => [
                          `${Number(value).toFixed(2)} GiB`,
                          String(name),
                        ]}
                        labelFormatter={label => new Date(String(label)).toLocaleString()}
                      />
                      <Legend />
                      {memoryCapacity && (
                        <ReferenceLine
                          y={memoryCapacity / 1024 ** 3}
                          stroke="var(--destructive)"
                          strokeDasharray="4 4"
                          label={{ value: 'Capacity', position: 'insideTopRight', fontSize: 10 }}
                        />
                      )}
                      {series.flatMap(item => [
                        <Line
                          key={item.memoryMaxKey}
                          type="monotone"
                          dataKey={item.memoryMaxKey}
                          stroke={item.color}
                          strokeWidth={2}
                          dot={false}
                          connectNulls={false}
                          isAnimationActive={false}
                          name={`${item.label} max`}
                        />,
                        <Line
                          key={item.memoryP95Key}
                          type="monotone"
                          dataKey={item.memoryP95Key}
                          stroke={item.color}
                          strokeWidth={1.5}
                          strokeDasharray="4 2"
                          dot={false}
                          connectNulls={false}
                          isAnimationActive={false}
                          name={`${item.label} P95`}
                        />,
                      ])}
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              </figure>

              <figure
                className="space-y-2"
                role="img"
                aria-label="Container CPU utilization over time"
              >
                <h3 className="text-sm font-medium">CPU Utilization</h3>
                <div className="h-64 w-full">
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={chartData} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                      <XAxis
                        dataKey="timestamp"
                        tick={{ fontSize: 10 }}
                        tickFormatter={value => formatTime(String(value))}
                        minTickGap={24}
                      />
                      <YAxis
                        tick={{ fontSize: 10 }}
                        tickFormatter={value => `${Number(value).toFixed(0)}%`}
                        width={48}
                      />
                      <Tooltip
                        formatter={(value, name) => [`${Number(value).toFixed(1)}%`, String(name)]}
                        labelFormatter={label => new Date(String(label)).toLocaleString()}
                      />
                      <Legend />
                      {series.flatMap(item => [
                        <Line
                          key={item.cpuAverageKey}
                          type="monotone"
                          dataKey={item.cpuAverageKey}
                          stroke={item.color}
                          strokeWidth={2}
                          dot={false}
                          connectNulls={false}
                          isAnimationActive={false}
                          name={`${item.label} average`}
                        />,
                        <Line
                          key={item.cpuP95Key}
                          type="monotone"
                          dataKey={item.cpuP95Key}
                          stroke={item.color}
                          strokeWidth={1.5}
                          strokeDasharray="4 2"
                          dot={false}
                          connectNulls={false}
                          isAnimationActive={false}
                          name={`${item.label} P95`}
                        />,
                      ])}
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              </figure>
            </div>

            <details>
              <summary className="text-sm font-medium">Metric samples ({rows.length})</summary>
              <div className="mt-3 overflow-x-auto">
                <Table>
                  <caption className="sr-only">
                    Cloudflare container workload metric samples
                  </caption>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Time</TableHead>
                      <TableHead>Memory max</TableHead>
                      <TableHead>Memory P95</TableHead>
                      <TableHead>CPU avg</TableHead>
                      <TableHead>CPU P95</TableHead>
                      <TableHead>Disk</TableHead>
                      <TableHead>RX / TX</TableHead>
                      <TableHead>Placement</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rows.map((row, index) => (
                      <TableRow
                        key={`${row.windowKey}-${row.timestamp}-${row.placementId}-${index}`}
                      >
                        <TableCell className="whitespace-nowrap font-mono text-xs">
                          {new Date(row.timestamp).toLocaleString()}
                        </TableCell>
                        <TableCell className="font-mono text-xs tabular-nums">
                          {formatBytes(row.max.memory)}
                        </TableCell>
                        <TableCell className="font-mono text-xs tabular-nums">
                          {formatBytes(row.quantiles.memoryP95)}
                        </TableCell>
                        <TableCell className="font-mono text-xs tabular-nums">
                          {formatPercent(row.avg.cpuUtilization)}
                        </TableCell>
                        <TableCell className="font-mono text-xs tabular-nums">
                          {formatPercent(row.quantiles.cpuUtilizationP95)}
                        </TableCell>
                        <TableCell className="font-mono text-xs tabular-nums">
                          {formatBytes(row.max.diskUsage)}
                        </TableCell>
                        <TableCell className="whitespace-nowrap font-mono text-xs tabular-nums">
                          {formatBytes(row.sum.rxBytes)} / {formatBytes(row.sum.txBytes)}
                        </TableCell>
                        <TableCell className="font-mono text-xs">{row.placementId}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </details>
          </>
        )}

        {latestInterval?.capacitySource === 'configured' && (
          <p className="text-muted-foreground text-xs">
            Capacity is inferred from the recorded container service for this historical interval.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
