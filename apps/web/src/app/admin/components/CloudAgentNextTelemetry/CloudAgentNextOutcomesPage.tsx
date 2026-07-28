'use client';

import { useEffect, useState } from 'react';
import { AlertCircle, Loader2, RefreshCw } from 'lucide-react';
import AdminPage from '@/app/admin/components/AdminPage';
import {
  useCloudAgentNextHealthErrorSessions,
  useCloudAgentNextHealthOverview,
  type CloudAgentNextHealthFilters,
  type CloudAgentFailureResponsibilityFilter,
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
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { rollingHealthInterval } from './health-interval';
import {
  DEFAULT_FAILURE_RESPONSIBILITY_FILTER,
  failureReasonLabel,
  getObservedHealthStats,
  type ObservedHealthOutcomeKind,
} from './health-summary';
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
type RangeOption = {
  value: RangeValue;
  label: string;
  durationMs: number;
};

const RANGE_OPTIONS = [
  { value: '1h', label: 'Last hour', durationMs: 60 * 60 * 1000 },
  { value: '3h', label: 'Last 3 hours', durationMs: 3 * 60 * 60 * 1000 },
  {
    value: '24h',
    label: 'Last 24 hours',
    durationMs: 24 * 60 * 60 * 1000,
  },
  { value: '7d', label: 'Last 7 days', durationMs: 7 * 24 * 60 * 60 * 1000 },
  { value: '14d', label: 'Last 14 days', durationMs: 14 * 24 * 60 * 60 * 1000 },
  { value: '30d', label: 'Last 30 days', durationMs: 30 * 24 * 60 * 60 * 1000 },
] satisfies ReadonlyArray<RangeOption>;

const DEFAULT_RANGE: RangeValue = DEFAULT_HEALTH_PERIOD;

const utcLongLabel = new Intl.DateTimeFormat('en-US', {
  timeZone: 'UTC',
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

function intervalForRange(range: RangeValue): CloudAgentNextHealthFilters {
  const selectedRange = RANGE_OPTIONS.find(option => option.value === range) ?? RANGE_OPTIONS[3];
  return rollingHealthInterval(selectedRange);
}

const outcomePresentation = {
  completed: {
    label: 'Completed runs',
    segment: 'bg-green-500',
    marker: 'border-green-500',
    value: 'text-green-400',
  },
  interrupted: {
    label: 'Interrupted runs',
    segment: 'bg-muted-foreground',
    marker: 'border-muted-foreground',
    value: 'text-foreground',
  },
  user: {
    label: 'User failures',
    segment: 'bg-yellow-500',
    marker: 'border-yellow-500',
    value: 'text-yellow-400',
  },
  platform: {
    label: 'Platform failures',
    segment: 'bg-red-500',
    marker: 'border-red-500',
    value: 'text-red-400',
  },
  unknown: {
    label: 'Unknown failures',
    segment: 'bg-gray-500',
    marker: 'border-gray-500',
    value: 'text-foreground',
  },
} satisfies Record<
  ObservedHealthOutcomeKind,
  { label: string; segment: string; marker: string; value: string }
>;

function DashboardSkeleton() {
  return (
    <div className="flex flex-col gap-6" role="status" aria-label="Loading Cloud Agent health">
      <Skeleton className="h-32 w-full" />
      <Skeleton className="h-72 w-full" />
    </div>
  );
}

function HealthSummary({ summary }: { summary: HealthData['summary'] }) {
  const stats = getObservedHealthStats(summary);
  const distributionLabel = stats.outcomes
    .map(outcome => `${outcomePresentation[outcome.kind].label}: ${outcome.count}`)
    .join(', ');
  return (
    <Card>
      <CardHeader>
        <CardTitle>Observed health</CardTitle>
        <CardDescription>
          Completed and interrupted runs alongside failures requiring user action, platform action,
          or further investigation. Every percentage is a share of all observed outcomes.
        </CardDescription>
        <p className="text-muted-foreground pt-2 text-sm tabular-nums">
          <span className="text-foreground font-semibold">
            {stats.observedOutcomes.toLocaleString()} observed outcomes
          </span>{' '}
          · {stats.observedRuns.toLocaleString()} runs + {stats.setupFailures.toLocaleString()}{' '}
          setup failures
        </p>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div
          className="bg-muted flex h-3 overflow-hidden rounded-full"
          role="group"
          aria-label={`Observed outcome distribution. ${distributionLabel}`}
        >
          {stats.outcomes
            .filter(outcome => outcome.count > 0)
            .map(outcome => {
              const presentation = outcomePresentation[outcome.kind];
              const share = outcome.sharePercent ?? 0;
              return (
                <Tooltip key={outcome.kind}>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      className={cn(
                        'h-full cursor-help focus-visible:z-10 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-white',
                        presentation.segment
                      )}
                      style={{ width: `${share}%` }}
                      aria-label={`${presentation.label}: ${outcome.count.toLocaleString()}, ${share.toFixed(1)}% of outcomes`}
                    />
                  </TooltipTrigger>
                  <TooltipContent>
                    <p className="font-medium">{presentation.label}</p>
                    <p className="text-muted-foreground tabular-nums">
                      {outcome.count.toLocaleString()} · {share.toFixed(1)}% of outcomes
                    </p>
                  </TooltipContent>
                </Tooltip>
              );
            })}
        </div>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
          {stats.outcomes.map(outcome => {
            const presentation = outcomePresentation[outcome.kind];
            return (
              <div
                key={outcome.kind}
                className={cn('min-w-0 border-l-2 pl-3', presentation.marker)}
              >
                <div className="text-muted-foreground min-h-8 text-xs">{presentation.label}</div>
                <div className={cn('mt-1 text-xl font-semibold tabular-nums', presentation.value)}>
                  {outcome.count.toLocaleString()}
                </div>
                <div className="text-muted-foreground mt-0.5 text-xs tabular-nums">
                  {outcome.sharePercent === null
                    ? '--'
                    : `${outcome.sharePercent.toFixed(1)}% of outcomes`}
                </div>
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}

function errorSourceBadge(source: TopError['source']) {
  return <Badge variant="secondary">{source === 'setup' ? 'Setup' : 'Run'}</Badge>;
}

const RESPONSIBILITY_LABELS = {
  platform: 'Platform',
  user: 'User',
  unknown: 'Unknown',
} as const;

function responsibilityBadge(responsibility: TopError['responsibility']) {
  return (
    <Badge
      variant={responsibility === 'platform' ? 'destructive' : 'secondary'}
      className={
        responsibility === 'user'
          ? 'border-yellow-500/30 bg-yellow-500/10 text-yellow-700 dark:text-yellow-300'
          : responsibility === 'unknown'
            ? 'text-muted-foreground'
            : undefined
      }
    >
      {RESPONSIBILITY_LABELS[responsibility]}
    </Badge>
  );
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
            {RESPONSIBILITY_LABELS[error.responsibility]} · {failureReasonLabel(error.reason)} ·{' '}
            <span className="font-mono text-xs">
              {error.source} / {error.stage} / {error.code}
            </span>{' '}
            — {error.count.toLocaleString()} matching error events in the selected period.
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
  responsibility,
  summary,
  onResponsibilityChange,
}: {
  errors: TopError[];
  interval: CloudAgentNextHealthFilters;
  responsibility: CloudAgentFailureResponsibilityFilter;
  summary: HealthData['summary'];
  onResponsibilityChange: (value: CloudAgentFailureResponsibilityFilter) => void;
}) {
  const [selectedError, setSelectedError] = useState<TopError | null>(null);
  const total = errors.reduce((count, error) => count + error.count, 0);
  return (
    <Card>
      <CardHeader>
        <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <CardTitle>Top errors</CardTitle>
            <CardDescription className="mt-1">
              Setup failures and failed runs only. {total.toLocaleString()} events in the top 10.
              Select an error to inspect sessions.
            </CardDescription>
          </div>
          <div className="flex min-w-52 flex-col gap-2">
            <Label htmlFor="cloud-agent-failure-responsibility">Responsibility</Label>
            <Select
              value={responsibility}
              onValueChange={value =>
                onResponsibilityChange(value as CloudAgentFailureResponsibilityFilter)
              }
            >
              <SelectTrigger id="cloud-agent-failure-responsibility">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="platform">
                  Platform ({summary.platformFailures.toLocaleString()})
                </SelectItem>
                <SelectItem value="user">User ({summary.userFailures.toLocaleString()})</SelectItem>
                <SelectItem value="unknown">
                  Unknown ({summary.unknownFailures.toLocaleString()})
                </SelectItem>
                <SelectItem value="all">
                  All failures ({(summary.failedRuns + summary.setupFailures).toLocaleString()})
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
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
                  <TableHead>Responsibility</TableHead>
                  <TableHead>Reason</TableHead>
                  <TableHead>Source</TableHead>
                  <TableHead className="text-right">Events</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {errors.map(error => (
                  <TableRow
                    key={`${error.responsibility}:${error.reason}:${error.source}:${error.stage}:${error.code}`}
                  >
                    <TableCell>{responsibilityBadge(error.responsibility)}</TableCell>
                    <TableCell className="p-1">
                      <Button
                        variant="ghost"
                        className="h-auto w-full justify-start px-2 py-2 text-left"
                        aria-label={`View affected sessions for ${RESPONSIBILITY_LABELS[error.responsibility]} ${failureReasonLabel(error.reason)}, ${error.count.toLocaleString()} events`}
                        onClick={() => setSelectedError(error)}
                      >
                        <span className="flex min-w-0 flex-col gap-0.5">
                          <span className="text-sm">{failureReasonLabel(error.reason)}</span>
                          <span className="text-muted-foreground font-mono text-xs">
                            {error.stage} / {error.code}
                          </span>
                        </span>
                      </Button>
                    </TableCell>
                    <TableCell>{errorSourceBadge(error.source)}</TableCell>
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

type HealthData = NonNullable<ReturnType<typeof useCloudAgentNextHealthOverview>['data']>;
type TopError = HealthData['topErrors'][number];

export default function CloudAgentNextOutcomesPage() {
  const [range, setRange] = useState<RangeValue>(DEFAULT_RANGE);
  const [interval, setInterval] = useState(() => intervalForRange(DEFAULT_RANGE));
  const [responsibility, setResponsibility] = useState<CloudAgentFailureResponsibilityFilter>(
    DEFAULT_FAILURE_RESPONSIBILITY_FILTER
  );
  const [hasLoadedPeriodPreference, setHasLoadedPeriodPreference] = useState(false);
  const health = useCloudAgentNextHealthOverview(
    interval,
    hasLoadedPeriodPreference,
    responsibility
  );

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
    setInterval(intervalForRange(value));
  }

  function refresh() {
    const nextInterval = intervalForRange(range);
    if (
      nextInterval.startDate === interval.startDate &&
      nextInterval.endDate === interval.endDate
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
              Operational outcomes from best-effort Cloud Agent reporting.
            </p>
          </div>
          <div className="flex flex-col gap-2 md:w-72">
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
        </div>
        <p className="text-muted-foreground text-xs">
          Reporting is best-effort, so totals can undercount execution. Periods end at refresh time.
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
            <TopErrors
              errors={health.data.topErrors}
              interval={interval}
              responsibility={responsibility}
              summary={health.data.summary}
              onResponsibilityChange={setResponsibility}
            />
          </>
        ) : null}
      </div>
    </AdminPage>
  );
}
