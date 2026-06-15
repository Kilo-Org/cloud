'use client';

import { useEffect, useState } from 'react';
import { AlertCircle, ChevronRight, Loader2, RefreshCw } from 'lucide-react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import AdminPage from '@/app/admin/components/AdminPage';
import {
  useCloudAgentNextHealthErrorSessions,
  useCloudAgentNextHealthOverview,
  useCloudAgentNextHealthPlatforms,
  type CloudAgentNextHealthFilters,
} from '@/app/admin/api/cloud-agent-next/hooks';
import { CopyButton } from '@/components/admin/CopyButton';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { BreadcrumbItem, BreadcrumbPage } from '@/components/ui/breadcrumb';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { rollingHealthInterval } from './health-interval';
import { getOperationalFailureStats } from './health-summary';
import {
  DEFAULT_HEALTH_PERIOD,
  getStoredHealthPeriod,
  isHealthPeriod,
  setStoredHealthPeriod,
  type HealthPeriod,
} from './health-period-preference';
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

type RangeValue = HealthPeriod;
type HealthBucket = CloudAgentNextHealthFilters['bucket'];
type RangeOption = {
  value: RangeValue;
  label: string;
  durationMs: number;
  bucket: HealthBucket;
};

const RANGE_OPTIONS = [
  { value: '1h', label: 'Last hour', durationMs: 60 * 60 * 1000, bucket: 'hour' },
  { value: '3h', label: 'Last 3 hours', durationMs: 3 * 60 * 60 * 1000, bucket: 'hour' },
  {
    value: '24h',
    label: 'Last 24 hours',
    durationMs: 24 * 60 * 60 * 1000,
    bucket: 'hour',
  },
  { value: '7d', label: 'Last 7 days', durationMs: 7 * 24 * 60 * 60 * 1000, bucket: 'hour' },
  { value: '14d', label: 'Last 14 days', durationMs: 14 * 24 * 60 * 60 * 1000, bucket: 'day' },
  { value: '30d', label: 'Last 30 days', durationMs: 30 * 24 * 60 * 60 * 1000, bucket: 'day' },
] satisfies ReadonlyArray<RangeOption>;

type HealthData = NonNullable<ReturnType<typeof useCloudAgentNextHealthOverview>['data']>;
type SeriesPoint = HealthData['series'][number];
type TopError = HealthData['topErrors'][number];
type TooltipPayload = { payload: SeriesPoint };

const DEFAULT_RANGE: RangeValue = DEFAULT_HEALTH_PERIOD;
const ALL_PLATFORMS_VALUE = 'all-platforms';
const UNKNOWN_PLATFORM_VALUE = 'unknown-platform';
const EXACT_PLATFORM_PREFIX = 'platform:';

function platformSelectionValue(platform: string): string {
  return `${EXACT_PLATFORM_PREFIX}${platform}`;
}

function createdOnPlatformForSelection(selection: string): string | null | undefined {
  if (selection === ALL_PLATFORMS_VALUE) return undefined;
  if (selection === UNKNOWN_PLATFORM_VALUE) return null;
  if (selection.startsWith(EXACT_PLATFORM_PREFIX)) {
    return selection.slice(EXACT_PLATFORM_PREFIX.length);
  }
  return undefined;
}

const utcLongLabel = new Intl.DateTimeFormat('en-US', {
  timeZone: 'UTC',
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});
const utcShortTime = new Intl.DateTimeFormat('en-US', {
  timeZone: 'UTC',
  hour: '2-digit',
  hourCycle: 'h23',
});
const utcShortDay = new Intl.DateTimeFormat('en-US', {
  timeZone: 'UTC',
  month: 'short',
  day: 'numeric',
});

function intervalForRange(
  range: RangeValue,
  platformSelection = ALL_PLATFORMS_VALUE
): CloudAgentNextHealthFilters {
  const selectedRange = RANGE_OPTIONS.find(option => option.value === range) ?? RANGE_OPTIONS[3];
  const createdOnPlatform = createdOnPlatformForSelection(platformSelection);
  return {
    ...rollingHealthInterval(selectedRange),
    ...(createdOnPlatform === undefined ? {} : { createdOnPlatform }),
  };
}

function formatBucketLabel(bucketStart: string, range: RangeValue): string {
  if (range === '1h' || range === '3h' || range === '24h') {
    return utcShortTime.format(new Date(bucketStart));
  }
  return utcShortDay.format(new Date(bucketStart));
}

function bucketLabel(bucket: HealthBucket): string {
  return bucket === 'day' ? 'Daily' : 'Hourly';
}

function formatBucketStart(bucketStart: string, bucket: HealthBucket): string {
  const date = new Date(bucketStart);
  return bucket === 'day' ? `${utcShortDay.format(date)} UTC` : `${utcLongLabel.format(date)} UTC`;
}

type MetricTone = 'success' | 'danger' | 'warning';

const metricToneStyles: Record<MetricTone, { panel: string; value: string }> = {
  success: {
    panel: 'border-green-500/20 bg-green-500/5',
    value: 'text-green-400',
  },
  danger: {
    panel: 'border-red-500/20 bg-red-500/5',
    value: 'text-red-400',
  },
  warning: {
    panel: 'border-yellow-500/20 bg-yellow-500/5',
    value: 'text-yellow-400',
  },
};

function Metric({
  label,
  value,
  detail,
  tone,
}: {
  label: string;
  value: string;
  detail?: string;
  tone: MetricTone;
}) {
  const styles = metricToneStyles[tone];
  return (
    <div className={cn('flex min-w-0 flex-col gap-1 rounded-lg border p-4', styles.panel)}>
      <div className="text-muted-foreground text-xs">{label}</div>
      <div className={cn('text-2xl font-semibold tabular-nums', styles.value)}>{value}</div>
      {detail && <div className="text-muted-foreground text-xs tabular-nums">{detail}</div>}
    </div>
  );
}

function DashboardSkeleton() {
  return (
    <div className="flex flex-col gap-6" role="status" aria-label="Loading Cloud Agent health">
      <Skeleton className="h-32 w-full" />
      <Skeleton className="h-96 w-full" />
      <Skeleton className="h-72 w-full" />
    </div>
  );
}

function HealthSummary({ summary }: { summary: HealthData['summary'] }) {
  const operationalFailures = getOperationalFailureStats(summary);
  const failureRate = operationalFailures.failureRatePercent;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Observed health</CardTitle>
        <CardDescription>
          Events observed in the selected rolling period. Interruptions are excluded from failure
          rate.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        <Metric
          label="Operational failure rate"
          value={failureRate === null ? '--' : `${failureRate.toFixed(1)}%`}
          detail={`${operationalFailures.failureEvents.toLocaleString()} failure events / ${operationalFailures.assessedOutcomes.toLocaleString()} assessed`}
          tone={operationalFailures.failureEvents > 0 ? 'danger' : 'success'}
        />
        <Metric
          label="Completed runs"
          value={summary.completedRuns.toLocaleString()}
          tone="success"
        />
        <Metric label="Failed runs" value={summary.failedRuns.toLocaleString()} tone="danger" />
        <Metric
          label="Setup failures"
          value={summary.setupFailures.toLocaleString()}
          tone="danger"
        />
        <Metric
          label="Interrupted runs"
          value={summary.interruptedRuns.toLocaleString()}
          detail="Excluded from failure rate"
          tone="warning"
        />
      </CardContent>
    </Card>
  );
}

function HealthTooltip({
  active,
  payload,
  bucket,
}: {
  active?: boolean;
  payload?: TooltipPayload[];
  bucket: HealthBucket;
}) {
  const point = active ? payload?.[0]?.payload : undefined;
  if (!point) return null;
  return (
    <div className="bg-popover text-popover-foreground rounded-lg border p-3 shadow-md">
      <p className="mb-2 text-xs font-medium">{formatBucketStart(point.bucketStart, bucket)}</p>
      <div className="grid gap-1 text-xs tabular-nums">
        <p className="flex justify-between gap-8">
          <span className="text-muted-foreground">Completed runs</span>
          <span>{point.completedRuns.toLocaleString()}</span>
        </p>
        <p className="flex justify-between gap-8">
          <span className="text-muted-foreground">Failed runs</span>
          <span>{point.failedRuns.toLocaleString()}</span>
        </p>
        <p className="flex justify-between gap-8">
          <span className="text-muted-foreground">Setup failures</span>
          <span>{point.setupFailures.toLocaleString()}</span>
        </p>
        <p className="flex justify-between gap-8">
          <span className="text-muted-foreground">Interrupted runs</span>
          <span>{point.interruptedRuns.toLocaleString()}</span>
        </p>
      </div>
    </div>
  );
}

function OutcomeTrendChart({
  data,
  range,
  bucket,
}: {
  data: SeriesPoint[];
  range: RangeValue;
  bucket: HealthBucket;
}) {
  const label = bucketLabel(bucket);
  return (
    <Card>
      <CardHeader>
        <CardTitle>{label} outcomes</CardTitle>
        <CardDescription>
          Completed, failed, setup-failed, and interrupted events in UTC-
          {bucket === 'day' ? 'day' : 'hour'} buckets. Edge buckets may be partial.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div
          className="h-80 w-full"
          role="img"
          aria-label={`${label} Cloud Agent outcome counts during the selected period`}
        >
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={data} margin={{ top: 8, right: 8, left: -8, bottom: 8 }}>
              <CartesianGrid strokeDasharray="3 3" className="stroke-border" vertical={false} />
              <XAxis
                dataKey="bucketStart"
                tickFormatter={bucketStart => formatBucketLabel(String(bucketStart), range)}
                minTickGap={32}
                tick={{ fontSize: 11 }}
              />
              <YAxis allowDecimals={false} width={46} tick={{ fontSize: 11 }} />
              <Tooltip content={<HealthTooltip bucket={bucket} />} />
              <Legend wrapperStyle={{ fontSize: '12px' }} />
              <Bar
                dataKey="completedRuns"
                stackId="outcomes"
                fill="var(--chart-2)"
                name="Completed"
              />
              <Bar dataKey="failedRuns" stackId="outcomes" fill="var(--chart-5)" name="Failed" />
              <Bar
                dataKey="setupFailures"
                stackId="outcomes"
                fill="var(--chart-3)"
                name="Setup failed"
              />
              <Bar
                dataKey="interruptedRuns"
                stackId="outcomes"
                fill="var(--chart-1)"
                name="Interrupted"
              />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </CardContent>
    </Card>
  );
}

function errorSourceBadge(source: TopError['source']) {
  return <Badge variant="secondary">{source === 'setup' ? 'Setup' : 'Run'}</Badge>;
}

function ErrorSessionsDialog({
  error,
  interval,
  onClose,
}: {
  error: TopError;
  interval: CloudAgentNextHealthFilters;
  onClose: () => void;
}) {
  const sessions = useCloudAgentNextHealthErrorSessions(interval, error);
  const rows = sessions.data?.rows ?? [];
  return (
    <Dialog open onOpenChange={open => !open && onClose()}>
      <DialogContent className="grid max-h-[calc(100vh-3rem)] w-[calc(100vw-2rem)] grid-rows-[auto_minmax(0,1fr)] overflow-hidden sm:max-w-5xl">
        <DialogHeader>
          <DialogTitle>Affected sessions</DialogTitle>
          <DialogDescription>
            <span className="font-mono text-xs">
              {error.source} / {error.stage} / {error.code}
            </span>{' '}
            - {error.count.toLocaleString()} matching error events in the selected period.
          </DialogDescription>
        </DialogHeader>
        {sessions.isLoading ? (
          <div
            className="text-muted-foreground flex items-center justify-center gap-2 py-10 text-sm"
            role="status"
          >
            <Loader2 className="size-4 animate-spin" /> Loading affected sessions...
          </div>
        ) : sessions.error ? (
          <Alert variant="destructive">
            <AlertCircle />
            <AlertTitle>Could not load affected sessions</AlertTitle>
            <AlertDescription>{sessions.error.message}</AlertDescription>
          </Alert>
        ) : rows.length === 0 ? (
          <p className="text-muted-foreground py-8 text-sm">
            No retained sessions found for this error.
          </p>
        ) : (
          <div className="flex min-h-0 flex-col gap-3 overflow-hidden">
            <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
              <p className="text-muted-foreground tabular-nums">
                Showing {rows.length.toLocaleString()} of{' '}
                {sessions.data?.totalSessions.toLocaleString()} affected sessions
                {sessions.data && sessions.data.totalSessions > sessions.data.limit
                  ? ' (newest first)'
                  : ''}
                .
              </p>
              <CopyButton
                text={rows.map(row => row.kiloSessionId).join('\n')}
                label="visible Kilo session IDs"
                showText
              />
            </div>
            <div className="min-h-0 overflow-auto rounded-lg border">
              <Table>
                <TableCaption className="sr-only">
                  Sessions affected by the selected Cloud Agent error.
                </TableCaption>
                <TableHeader className="bg-card sticky top-0 z-10">
                  <TableRow>
                    <TableHead>Kilo session ID</TableHead>
                    <TableHead>Cloud Agent ID</TableHead>
                    <TableHead>Latest occurrence (UTC)</TableHead>
                    <TableHead className="text-right">Events</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map(row => (
                    <TableRow key={row.cloudAgentSessionId}>
                      <TableCell className="font-mono text-xs">
                        <span className="flex items-center gap-1">
                          {row.kiloSessionId}
                          <CopyButton text={row.kiloSessionId} label="Kilo session ID" />
                        </span>
                      </TableCell>
                      <TableCell className="font-mono text-xs">
                        <span className="flex items-center gap-1">
                          {row.cloudAgentSessionId}
                          <CopyButton text={row.cloudAgentSessionId} label="Cloud Agent ID" />
                        </span>
                      </TableCell>
                      <TableCell className="text-muted-foreground font-mono text-xs whitespace-nowrap">
                        {row.occurredAt
                          ? `${utcLongLabel.format(new Date(row.occurredAt))} UTC`
                          : '--'}
                      </TableCell>
                      <TableCell className="text-right font-mono tabular-nums">
                        {row.matchingEvents.toLocaleString()}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function TopErrors({
  errors,
  interval,
}: {
  errors: TopError[];
  interval: CloudAgentNextHealthFilters;
}) {
  const [selectedError, setSelectedError] = useState<TopError | null>(null);
  const total = errors.reduce((count, error) => count + error.count, 0);
  return (
    <Card>
      <CardHeader>
        <CardTitle>Top errors</CardTitle>
        <CardDescription>
          Setup failures and failed runs only. {total.toLocaleString()} events in the top 10. Select
          an error to inspect sessions.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {errors.length === 0 ? (
          <p className="text-muted-foreground py-8 text-sm">
            No operational errors observed in this period.
          </p>
        ) : (
          <div className="overflow-x-auto rounded-lg border">
            <Table>
              <TableCaption className="sr-only">
                Top operational Cloud Agent errors in the selected period. Select an error to
                inspect affected sessions.
              </TableCaption>
              <TableHeader>
                <TableRow>
                  <TableHead>Source</TableHead>
                  <TableHead>Error</TableHead>
                  <TableHead className="text-right">Events</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {errors.map(error => (
                  <TableRow key={`${error.source}:${error.stage}:${error.code}`}>
                    <TableCell>{errorSourceBadge(error.source)}</TableCell>
                    <TableCell className="p-1">
                      <Button
                        variant="ghost"
                        className="h-auto w-full justify-start gap-2 px-2 py-2 font-mono text-xs"
                        aria-label={`View affected sessions for ${error.source} error ${error.stage} / ${error.code}, ${error.count.toLocaleString()} events`}
                        onClick={() => setSelectedError(error)}
                      >
                        {error.stage} / {error.code}
                        <ChevronRight className="text-muted-foreground size-4" />
                      </Button>
                    </TableCell>
                    <TableCell className="text-right font-mono tabular-nums">
                      {error.count.toLocaleString()}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
        {selectedError && (
          <ErrorSessionsDialog
            error={selectedError}
            interval={interval}
            onClose={() => setSelectedError(null)}
          />
        )}
      </CardContent>
    </Card>
  );
}

export default function CloudAgentNextOutcomesPage() {
  const [range, setRange] = useState<RangeValue>(DEFAULT_RANGE);
  const [platformSelection, setPlatformSelection] = useState(ALL_PLATFORMS_VALUE);
  const [interval, setInterval] = useState(() => intervalForRange(DEFAULT_RANGE));
  const [hasLoadedPeriodPreference, setHasLoadedPeriodPreference] = useState(false);
  const healthPlatforms = useCloudAgentNextHealthPlatforms();
  const health = useCloudAgentNextHealthOverview(interval, hasLoadedPeriodPreference);
  const bucket = interval.bucket;

  useEffect(() => {
    const storedRange = getStoredHealthPeriod();
    if (storedRange !== DEFAULT_RANGE) {
      setRange(storedRange);
      setInterval(intervalForRange(storedRange));
    }
    setHasLoadedPeriodPreference(true);
  }, []);

  function updateRange(value: string) {
    if (!isHealthPeriod(value)) return;
    setStoredHealthPeriod(value);
    setRange(value);
    setInterval(intervalForRange(value, platformSelection));
  }

  function updatePlatformSelection(value: string) {
    setPlatformSelection(value);
    setInterval(intervalForRange(range, value));
  }

  function refresh() {
    const nextInterval = intervalForRange(range, platformSelection);
    if (
      nextInterval.startDate === interval.startDate &&
      nextInterval.endDate === interval.endDate &&
      nextInterval.bucket === interval.bucket &&
      nextInterval.createdOnPlatform === interval.createdOnPlatform
    ) {
      void health.refetch();
      return;
    }
    setInterval(nextInterval);
  }

  return (
    <AdminPage
      breadcrumbs={
        <BreadcrumbItem>
          <BreadcrumbPage>Cloud Agent health</BreadcrumbPage>
        </BreadcrumbItem>
      }
      buttons={
        <Button variant="outline" size="sm" onClick={refresh} disabled={health.isFetching}>
          <RefreshCw className={health.isFetching ? 'animate-spin' : ''} /> Refresh
        </Button>
      }
    >
      <div className="flex w-full flex-col gap-6">
        <div className="flex flex-col justify-between gap-4 md:flex-row md:items-end">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Cloud Agent health</h1>
            <p className="text-muted-foreground mt-1 max-w-2xl text-sm">
              Operational outcome trends from best-effort Cloud Agent reporting.
            </p>
          </div>
          <div className="grid w-full gap-3 sm:grid-cols-2 md:w-auto md:min-w-[32rem]">
            <div className="flex flex-col gap-2">
              <Label htmlFor="cloud-agent-health-period">Period</Label>
              <Select value={range} onValueChange={updateRange}>
                <SelectTrigger id="cloud-agent-health-period" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {RANGE_OPTIONS.map(option => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="cloud-agent-health-platform">Created on platform</Label>
              <Select value={platformSelection} onValueChange={updatePlatformSelection}>
                <SelectTrigger id="cloud-agent-health-platform" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL_PLATFORMS_VALUE}>All platforms</SelectItem>
                  {healthPlatforms.isLoading && (
                    <SelectItem value="loading-platforms" disabled>
                      Loading platforms...
                    </SelectItem>
                  )}
                  {healthPlatforms.error && (
                    <SelectItem value="platforms-unavailable" disabled>
                      Platforms unavailable
                    </SelectItem>
                  )}
                  {healthPlatforms.data?.map(platform => (
                    <SelectItem key={platform} value={platformSelectionValue(platform)}>
                      <span className="font-mono text-xs">{platform}</span>
                    </SelectItem>
                  ))}
                  <SelectItem value={UNKNOWN_PLATFORM_VALUE}>Unknown / unlinked</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        </div>
        <p className="text-muted-foreground text-xs">
          Reporting is best-effort, so totals can undercount execution. Periods end at refresh time;
          edge UTC {bucket === 'day' ? 'days' : 'hours'} may be partial.
        </p>
        {health.error && (
          <Alert variant="destructive">
            <AlertCircle />
            <AlertTitle>Could not load Cloud Agent health</AlertTitle>
            <AlertDescription>{health.error.message}</AlertDescription>
          </Alert>
        )}
        {health.isFetching && !health.isLoading && (
          <div className="text-muted-foreground flex items-center gap-2 text-sm" role="status">
            <Loader2 className="size-4 animate-spin" /> Refreshing health data...
          </div>
        )}
        {!hasLoadedPeriodPreference || health.isLoading ? (
          <DashboardSkeleton />
        ) : health.data ? (
          <>
            <HealthSummary summary={health.data.summary} />
            <OutcomeTrendChart data={health.data.series} range={range} bucket={bucket} />
            <TopErrors errors={health.data.topErrors} interval={interval} />
          </>
        ) : null}
      </div>
    </AdminPage>
  );
}
