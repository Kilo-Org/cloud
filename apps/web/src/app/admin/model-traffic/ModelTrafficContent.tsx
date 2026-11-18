'use client';

import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { inferRouterInputs, inferRouterOutputs } from '@trpc/server';
import { format } from 'date-fns';
import {
  Area,
  AreaChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { LegendPayload, TooltipPayload } from 'recharts';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useTRPC } from '@/lib/trpc/utils';
import type { RootRouter } from '@/routers/root-router';

type ModelTraffic = inferRouterOutputs<RootRouter>['admin']['modelTraffic']['get'];
type ModelTrafficRange = inferRouterInputs<RootRouter>['admin']['modelTraffic']['get']['range'];
type RequestSeries = ModelTraffic['allModels'];
type TooltipEntry = TooltipPayload[number];

type ChartSeries = {
  key: string;
  label: string;
  color: string;
  data: RequestSeries;
  dashed?: boolean;
};

type ChartRow = { timestamp: number } & Record<string, number | null>;

const REFRESH_INTERVAL_MS = 60_000;
const CHART_HEIGHT_CLASS = 'h-[360px]';
const CHART_STYLE = { width: '100%', height: '100%' };
// A handful of requests in a bucket makes a single failure read as a huge error rate.
const MIN_REQUESTS_FOR_ERROR_RATE = 20;

const RANGE_OPTIONS: Array<{ value: ModelTrafficRange; label: string }> = [
  { value: 'day', label: '24 hours' },
  { value: 'week', label: '7 days' },
];

function isModelTrafficRange(value: string): value is ModelTrafficRange {
  return RANGE_OPTIONS.some(option => option.value === value);
}

const MODEL_COLORS = [
  '#2563eb',
  '#dc2626',
  '#16a34a',
  '#ca8a04',
  '#9333ea',
  '#0891b2',
  '#f472b6',
  '#65a30d',
  '#c026d3',
  '#ea580c',
];
const OTHER_MODELS_COLOR = '#94a3b8';

const compactNumber = new Intl.NumberFormat(undefined, { notation: 'compact' });

function formatPercent(value: number): string {
  return `${value < 10 ? value.toFixed(2) : value.toFixed(1)}%`;
}

function formatBucketRange(timestamp: number, bucketMinutes: number): string {
  const end = timestamp + bucketMinutes * 60 * 1000;
  return `${format(timestamp, 'MMM d, HH:mm')} – ${format(end, 'HH:mm')}`;
}

function formatBucketSize(bucketMinutes: number): string {
  return bucketMinutes % 60 === 0 ? `${bucketMinutes / 60}-hour` : `${bucketMinutes}-minute`;
}

function errorRate(series: RequestSeries, index: number): number | null {
  const requests = series.requests[index];
  if (requests < MIN_REQUESTS_FOR_ERROR_RATE) return null;
  return (series.errors[index] / requests) * 100;
}

// All-zero or fully filtered-out data would otherwise give a zero-height or non-finite axis.
function errorRateAxisMax(dataMax: number): number {
  return Number.isFinite(dataMax) ? Math.max(1, Math.min(100, Math.ceil(dataMax))) : 100;
}

function useModelTraffic(range: ModelTrafficRange, excludeByok: boolean) {
  const trpc = useTRPC();
  return useQuery({
    ...trpc.admin.modelTraffic.get.queryOptions({ range, excludeByok }),
    refetchInterval: REFRESH_INTERVAL_MS,
  });
}

function modelSeries(traffic: ModelTraffic): ChartSeries[] {
  return traffic.models.map((model, index) => ({
    key: `model${index}`,
    label: model.model,
    color: MODEL_COLORS[index % MODEL_COLORS.length],
    data: model,
  }));
}

// Hidden series are tracked by model name so they stay hidden when the top-model ranking shifts.
function toggleLabel(hidden: ReadonlySet<string>, entry: LegendPayload): Set<string> {
  const next = new Set(hidden);
  if (typeof entry.value !== 'string') return next;
  if (next.has(entry.value)) next.delete(entry.value);
  else next.add(entry.value);
  return next;
}

function timeAxisProps(traffic: ModelTraffic) {
  const tickFormat = traffic.windowHours > 24 ? 'MMM d HH:mm' : 'HH:mm';
  return {
    dataKey: 'timestamp',
    type: 'number',
    scale: 'time',
    domain: ['dataMin', 'dataMax'],
    tick: { fontSize: 11 },
    tickFormatter: (value: number) => format(value, tickFormat),
    minTickGap: 32,
  } as const;
}

type SeriesTooltipProps = {
  active?: boolean;
  payload?: TooltipPayload;
  label?: string | number;
  bucketMinutes: number;
  formatValue: (entry: TooltipEntry) => string;
  showTotal?: boolean;
};

function SeriesTooltip({
  active,
  payload,
  label,
  bucketMinutes,
  formatValue,
  showTotal,
}: SeriesTooltipProps) {
  if (!active || !payload?.length || typeof label !== 'number') return null;
  const entries = payload
    .filter(entry => typeof entry.value === 'number')
    .sort((a, b) => Number(b.value) - Number(a.value));
  if (entries.length === 0) return null;
  const total = entries.reduce((sum, entry) => sum + Number(entry.value), 0);

  return (
    <div className="bg-popover text-popover-foreground rounded-md border p-3 text-xs shadow-md">
      <p className="mb-2 font-medium">{formatBucketRange(label, bucketMinutes)}</p>
      <div className="space-y-1">
        {entries.map(entry => (
          <p key={String(entry.dataKey)} className="flex items-center justify-between gap-6">
            <span className="flex min-w-0 items-center gap-2">
              <span
                className="inline-block size-2.5 shrink-0 rounded-full"
                style={{ backgroundColor: entry.color }}
              />
              <span className="text-muted-foreground truncate font-mono">{entry.name}</span>
            </span>
            <span className="font-medium tabular-nums">{formatValue(entry)}</span>
          </p>
        ))}
        {showTotal && (
          <p className="flex items-center justify-between gap-6 border-t pt-1 font-medium">
            <span>Total</span>
            <span className="tabular-nums">{total.toLocaleString()}</span>
          </p>
        )}
      </div>
    </div>
  );
}

function ChartCard({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent>
        <div className={`${CHART_HEIGHT_CLASS} w-full`}>{children}</div>
      </CardContent>
    </Card>
  );
}

function RequestVolumeChart({
  traffic,
  hidden,
  onToggle,
}: {
  traffic: ModelTraffic;
  hidden: ReadonlySet<string>;
  onToggle: (entry: LegendPayload) => void;
}) {
  const series = useMemo<ChartSeries[]>(
    () => [
      ...modelSeries(traffic),
      {
        key: 'otherModels',
        label: 'Other models',
        color: OTHER_MODELS_COLOR,
        data: traffic.otherModels,
      },
    ],
    [traffic]
  );
  const rows = useMemo<ChartRow[]>(
    () =>
      traffic.bucketStarts.map((bucketStart, index) => {
        const row: ChartRow = { timestamp: Date.parse(bucketStart) };
        for (const item of series) row[item.key] = item.data.requests[index];
        return row;
      }),
    [traffic, series]
  );

  return (
    <ChartCard
      title="Request volume"
      description={`Successful and failed requests per ${formatBucketSize(traffic.bucketMinutes)} bucket, stacked by model. Click a legend entry to hide it.`}
    >
      <AreaChart
        responsive
        style={CHART_STYLE}
        data={rows}
        margin={{ top: 8, right: 12, left: 0, bottom: 0 }}
      >
        <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
        <XAxis {...timeAxisProps(traffic)} />
        <YAxis
          tick={{ fontSize: 11 }}
          tickFormatter={(value: number) => compactNumber.format(value)}
          width={48}
        />
        <Tooltip
          content={
            <SeriesTooltip
              bucketMinutes={traffic.bucketMinutes}
              formatValue={entry => Number(entry.value).toLocaleString()}
              showTotal
            />
          }
        />
        <Legend
          onClick={onToggle}
          itemSorter={null}
          wrapperStyle={{ fontSize: 12, cursor: 'pointer' }}
        />
        {series.map(item => (
          <Area
            key={item.key}
            dataKey={item.key}
            name={item.label}
            stackId="requests"
            type="monotone"
            stroke={item.color}
            fill={item.color}
            fillOpacity={0.5}
            strokeWidth={1}
            hide={hidden.has(item.label)}
            isAnimationActive={false}
          />
        ))}
      </AreaChart>
    </ChartCard>
  );
}

function ErrorRateChart({
  traffic,
  hidden,
  onToggle,
}: {
  traffic: ModelTraffic;
  hidden: ReadonlySet<string>;
  onToggle: (entry: LegendPayload) => void;
}) {
  const series = useMemo<ChartSeries[]>(
    () => [
      {
        key: 'allModels',
        label: 'All models',
        color: 'var(--foreground)',
        data: traffic.allModels,
        dashed: true,
      },
      ...modelSeries(traffic),
    ],
    [traffic]
  );
  const rows = useMemo<ChartRow[]>(
    () =>
      traffic.bucketStarts.map((bucketStart, index) => {
        const row: ChartRow = { timestamp: Date.parse(bucketStart) };
        for (const item of series) {
          row[item.key] = errorRate(item.data, index);
          row[`${item.key}Errors`] = item.data.errors[index];
          row[`${item.key}Requests`] = item.data.requests[index];
        }
        return row;
      }),
    [traffic, series]
  );
  const rowsByTimestamp = useMemo(() => new Map(rows.map(row => [row.timestamp, row])), [rows]);

  return (
    <ChartCard
      title="Error rate"
      description={`Share of requests with HTTP status ≥ 400 per ${formatBucketSize(traffic.bucketMinutes)} bucket. Buckets with fewer than ${MIN_REQUESTS_FOR_ERROR_RATE} requests are left out.`}
    >
      <LineChart
        responsive
        style={CHART_STYLE}
        data={rows}
        margin={{ top: 8, right: 12, left: 0, bottom: 0 }}
      >
        <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
        <XAxis {...timeAxisProps(traffic)} />
        <YAxis
          tick={{ fontSize: 11 }}
          tickFormatter={(value: number) => `${value}%`}
          domain={[0, errorRateAxisMax]}
          allowDecimals={false}
          width={48}
        />
        <Tooltip
          content={({ active, payload, label }) => (
            <SeriesTooltip
              active={active}
              payload={payload}
              label={label}
              bucketMinutes={traffic.bucketMinutes}
              formatValue={entry => {
                const row = typeof label === 'number' ? rowsByTimestamp.get(label) : undefined;
                const key = String(entry.dataKey);
                const errors = row?.[`${key}Errors`] ?? 0;
                const requests = row?.[`${key}Requests`] ?? 0;
                return `${formatPercent(Number(entry.value))} (${errors.toLocaleString()} / ${requests.toLocaleString()})`;
              }}
            />
          )}
        />
        <Legend
          onClick={onToggle}
          itemSorter={null}
          wrapperStyle={{ fontSize: 12, cursor: 'pointer' }}
        />
        {series.map(item => (
          <Line
            key={item.key}
            dataKey={item.key}
            name={item.label}
            type="monotone"
            stroke={item.color}
            strokeWidth={item.dashed ? 2 : 1.5}
            strokeDasharray={item.dashed ? '6 3' : undefined}
            dot={false}
            connectNulls={false}
            hide={hidden.has(item.label)}
            isAnimationActive={false}
          />
        ))}
      </LineChart>
    </ChartCard>
  );
}

function ChartPlaceholder({ title, message }: { title: string; message?: string }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        {message && <CardDescription className="text-destructive">{message}</CardDescription>}
      </CardHeader>
      <CardContent>
        {!message && (
          <div className={`bg-muted ${CHART_HEIGHT_CLASS} w-full animate-pulse rounded`} />
        )}
      </CardContent>
    </Card>
  );
}

export function ModelTrafficContent() {
  const [range, setRange] = useState<ModelTrafficRange>('day');
  const [excludeByok, setExcludeByok] = useState(true);
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
  const { data, error, dataUpdatedAt } = useModelTraffic(range, excludeByok);
  const onToggle = (entry: LegendPayload) => setHidden(current => toggleLabel(current, entry));

  return (
    <div className="flex w-full flex-col gap-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h2 className="text-2xl font-bold">Model Traffic</h2>
          <p className="text-muted-foreground text-sm">
            Kilo Gateway requests from <code>o11y_api_metrics</code>, top models by volume.
            Refreshes every minute
            {dataUpdatedAt > 0 && ` (last updated ${format(dataUpdatedAt, 'HH:mm:ss')})`}.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-4">
          <Tabs
            value={range}
            onValueChange={value => {
              if (isModelTrafficRange(value)) setRange(value);
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
          <div className="flex items-center gap-2">
            <Switch id="exclude-byok" checked={excludeByok} onCheckedChange={setExcludeByok} />
            <Label htmlFor="exclude-byok">Exclude BYOK</Label>
          </div>
        </div>
      </div>

      {data ? (
        <>
          {error && (
            <Alert variant="warning">
              <AlertDescription>
                Refresh failed: {error.message}. Showing data from{' '}
                {format(dataUpdatedAt, 'HH:mm:ss')}.
              </AlertDescription>
            </Alert>
          )}
          <RequestVolumeChart traffic={data} hidden={hidden} onToggle={onToggle} />
          <ErrorRateChart traffic={data} hidden={hidden} onToggle={onToggle} />
        </>
      ) : error ? (
        <ChartPlaceholder title="Model traffic" message={error.message} />
      ) : (
        <>
          <ChartPlaceholder title="Request volume" />
          <ChartPlaceholder title="Error rate" />
        </>
      )}
    </div>
  );
}
