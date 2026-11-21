'use client';

import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { inferRouterOutputs } from '@trpc/server';
import { format } from 'date-fns';
import { Area, AreaChart, CartesianGrid, Tooltip, XAxis, YAxis } from 'recharts';
import type { TooltipPayload } from 'recharts';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useTRPC } from '@/lib/trpc/utils';
import type { RootRouter } from '@/routers/root-router';

type EnkryptCallCounts = inferRouterOutputs<RootRouter>['admin']['enkryptCalls']['perMinute'];
type ChartRow = { timestamp: number; calls: number };

const REFRESH_INTERVAL_MS = 60_000;
const CHART_STYLE = { width: '100%', height: '100%' };

const RANGE_OPTIONS = [
  { value: '60', label: '1 hour' },
  { value: '360', label: '6 hours' },
  { value: '1440', label: '24 hours' },
] as const;
type Range = (typeof RANGE_OPTIONS)[number]['value'];

function isRange(value: string): value is Range {
  return RANGE_OPTIONS.some(option => option.value === value);
}

const compactNumber = new Intl.NumberFormat(undefined, { notation: 'compact' });

function CallsTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: TooltipPayload;
  label?: string | number;
}) {
  if (!active || !payload?.length || typeof label !== 'number') return null;
  return (
    <div className="bg-popover text-popover-foreground rounded-md border p-3 text-xs shadow-md">
      <p className="mb-1 font-medium">
        {format(label, 'MMM d, HH:mm')} – {format(label + 60_000, 'HH:mm')}
      </p>
      <p className="tabular-nums">{Number(payload[0].value).toLocaleString()} calls</p>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-muted-foreground text-xs">{label}</span>
      <span className="text-xl font-semibold tabular-nums">{value.toLocaleString()}</span>
    </div>
  );
}

function CallsChart({ counts, minutes }: { counts: EnkryptCallCounts; minutes: number }) {
  const rows = useMemo<ChartRow[]>(() => {
    const start = Math.max(0, counts.bucketStarts.length - minutes);
    return counts.bucketStarts
      .slice(start)
      .map((timestamp, index) => ({ timestamp, calls: counts.calls[start + index] }));
  }, [counts, minutes]);
  const total = rows.reduce((sum, row) => sum + row.calls, 0);
  const peak = rows.reduce((max, row) => Math.max(max, row.calls), 0);
  const tickFormat = minutes > 360 ? 'MMM d HH:mm' : 'HH:mm';

  return (
    <CardContent className="flex flex-col gap-6">
      <div className="flex flex-wrap gap-8">
        <Stat label="Total calls" value={total} />
        <Stat label="Peak per minute" value={peak} />
        <Stat label="Average per minute" value={Math.round(total / Math.max(1, rows.length))} />
      </div>
      <div className="h-[360px] w-full">
        <AreaChart
          responsive
          style={CHART_STYLE}
          data={rows}
          margin={{ top: 8, right: 12, left: 0, bottom: 0 }}
        >
          <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
          <XAxis
            dataKey="timestamp"
            type="number"
            scale="time"
            domain={['dataMin', 'dataMax']}
            tick={{ fontSize: 11 }}
            tickFormatter={(value: number) => format(value, tickFormat)}
            minTickGap={32}
          />
          <YAxis
            tick={{ fontSize: 11 }}
            tickFormatter={(value: number) => compactNumber.format(value)}
            allowDecimals={false}
            width={48}
          />
          <Tooltip content={<CallsTooltip />} />
          <Area
            dataKey="calls"
            name="Calls"
            type="linear"
            stroke="#2563eb"
            fill="#2563eb"
            fillOpacity={0.4}
            strokeWidth={1}
            isAnimationActive={false}
          />
        </AreaChart>
      </div>
    </CardContent>
  );
}

export function EnkryptCallsContent() {
  const trpc = useTRPC();
  const [range, setRange] = useState<Range>('1440');
  const { data, error, dataUpdatedAt } = useQuery({
    ...trpc.admin.enkryptCalls.perMinute.queryOptions(),
    refetchInterval: REFRESH_INTERVAL_MS,
  });

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-4">
        <div className="flex flex-col gap-1.5">
          <CardTitle>Enkrypt calls</CardTitle>
          <CardDescription>
            Requests the input and output guardrails sent to Enkrypt, per minute. Kept in Redis for
            24 hours. Refreshes every minute
            {dataUpdatedAt > 0 && ` (last updated ${format(dataUpdatedAt, 'HH:mm:ss')})`}.
          </CardDescription>
        </div>
        <Tabs
          value={range}
          onValueChange={value => {
            if (isRange(value)) setRange(value);
          }}
        >
          <TabsList>
            {RANGE_OPTIONS.map(option => (
              <TabsTrigger key={option.value} value={option.value}>
                {option.label}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      </CardHeader>
      {data ? (
        <>
          {error && (
            <CardContent>
              <Alert variant="warning">
                <AlertDescription>
                  Refresh failed: {error.message}. Showing data from{' '}
                  {format(dataUpdatedAt, 'HH:mm:ss')}.
                </AlertDescription>
              </Alert>
            </CardContent>
          )}
          <CallsChart counts={data} minutes={Number(range)} />
        </>
      ) : (
        <CardContent>
          {error ? (
            <p className="text-destructive text-sm">{error.message}</p>
          ) : (
            <div className="bg-muted h-[360px] w-full animate-pulse rounded" />
          )}
        </CardContent>
      )}
    </Card>
  );
}
