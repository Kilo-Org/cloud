'use client';

import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ChartColumnIncreasing,
  CircleGauge,
  GitPullRequest,
  Loader2,
  MessageSquareWarning,
  PauseCircle,
  RefreshCw,
  ShieldAlert,
  TrendingUp,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';

import { MetricCard } from '@/components/usage-analytics/MetricCard';
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
import { Switch } from '@/components/ui/switch';
import { useTRPC } from '@/lib/trpc/utils';
import { AnalyticsBreakdownBars } from './AnalyticsBreakdownBars';
import { AnalyticsTables } from './AnalyticsTables';

type CodeReviewAnalyticsPanelProps = {
  organizationId: string;
  platform: 'github' | 'gitlab';
};

type PeriodDays = 7 | 30 | 90;

const ALL_REPOSITORIES = '__all_repositories__';

function formatCount(value: number): string {
  return value.toLocaleString();
}

function AnalyticsBreakdownSkeletonCard({ rows }: { rows: number }) {
  return (
    <Card>
      <CardHeader className="pb-4">
        <Skeleton className="h-5 w-40" />
      </CardHeader>
      <CardContent className="space-y-3">
        {Array.from({ length: rows }, (_, row) => (
          <div key={row} className="space-y-2">
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-2 w-full rounded-full" />
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

function AnalyticsLoadingState({ platform }: Pick<CodeReviewAnalyticsPanelProps, 'platform'>) {
  const changeLabel = platform === 'github' ? 'Tracked PRs' : 'Tracked MRs';

  return (
    <div className="space-y-6" aria-busy="true" aria-label="Loading review analytics">
      <span className="sr-only" role="status">
        Loading review analytics
      </span>
      <Card>
        <CardHeader>
          <Skeleton className="h-5 w-44" />
          <Skeleton className="h-4 w-full max-w-xl" />
        </CardHeader>
        <CardContent className="flex items-center justify-between gap-4">
          <div className="space-y-2">
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-4 w-64 max-w-full" />
          </div>
          <Skeleton className="h-6 w-11 rounded-full" />
        </CardContent>
      </Card>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Skeleton className="h-4 w-16" />
          <Skeleton className="h-9 w-full" />
        </div>
        <div className="space-y-2">
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-9 w-full" />
        </div>
      </div>

      <div className="rounded-xl border p-4">
        <Skeleton className="h-4 w-full max-w-md" />
        <Skeleton className="mt-3 h-3 w-full max-w-sm" />
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <MetricCard title={changeLabel} value="" icon={GitPullRequest} loading />
        <MetricCard title="Impact points" value="" icon={CircleGauge} loading />
        <MetricCard title="High impact" value="" icon={TrendingUp} loading />
        <MetricCard title="Findings raised" value="" icon={MessageSquareWarning} loading />
      </div>

      <div className="space-y-8">
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Skeleton className="h-6 w-36" />
            <Skeleton className="h-4 w-full max-w-2xl" />
          </div>
          <div className="grid gap-6 lg:grid-cols-2">
            <div className="grid gap-6">
              <AnalyticsBreakdownSkeletonCard rows={4} />
              <AnalyticsBreakdownSkeletonCard rows={3} />
            </div>
            <AnalyticsBreakdownSkeletonCard rows={8} />
          </div>
        </div>

        <div className="space-y-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
            <div className="space-y-1.5">
              <Skeleton className="h-6 w-40" />
              <Skeleton className="h-4 w-full max-w-xl" />
            </div>
            <Skeleton className="h-4 w-56 max-w-full" />
          </div>
          <div className="grid gap-6 lg:grid-cols-2 lg:items-start">
            <AnalyticsBreakdownSkeletonCard rows={6} />
            <AnalyticsBreakdownSkeletonCard rows={4} />
          </div>
        </div>
      </div>

      <Card>
        <CardHeader>
          <Skeleton className="h-5 w-32" />
          <Skeleton className="h-4 w-full max-w-lg" />
        </CardHeader>
        <CardContent className="space-y-3">
          {[0, 1, 2, 3].map(row => (
            <Skeleton key={row} className="h-9 w-full" />
          ))}
        </CardContent>
      </Card>

      {platform === 'github' && (
        <Card>
          <CardHeader>
            <Skeleton className="h-5 w-48" />
            <Skeleton className="h-4 w-full max-w-2xl" />
          </CardHeader>
          <CardContent>
            <Skeleton className="h-32 w-full" />
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function AnalyticsCollectionCard({
  enabled,
  canManage,
  isPending,
  onEnabledChange,
}: {
  enabled: boolean;
  canManage: boolean;
  isPending: boolean;
  onEnabledChange: (enabled: boolean) => void;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ChartColumnIncreasing className="size-5" aria-hidden="true" />
          Analytics collection
        </CardTitle>
        <CardDescription>
          Record taxonomy and estimated impact for future completed reviews. Existing reviews are
          not backfilled.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        {canManage ? (
          <div className="space-y-1">
            <Label htmlFor="review-analytics-enabled">Enable analytics collection</Label>
            <p id="review-analytics-enabled-description" className="text-muted-foreground text-sm">
              Disabling collection pauses future enrollment and keeps existing analytics available.
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            <Badge variant={enabled ? 'secondary' : 'outline'}>
              {enabled ? 'Collecting' : 'Paused'}
            </Badge>
            <p className="text-muted-foreground text-sm">
              You can view organization analytics. Only organization owners and billing managers can
              change collection.
            </p>
          </div>
        )}
        {canManage && (
          <Switch
            id="review-analytics-enabled"
            checked={enabled}
            disabled={isPending}
            onCheckedChange={onEnabledChange}
            aria-describedby="review-analytics-enabled-description"
            aria-label="Enable analytics collection"
          />
        )}
      </CardContent>
    </Card>
  );
}

function AnalyticsFilters({
  period,
  repository,
  repositoryOptions,
  updating,
  onPeriodChange,
  onRepositoryChange,
}: {
  period: PeriodDays;
  repository?: string;
  repositoryOptions: string[];
  updating: boolean;
  onPeriodChange: (period: PeriodDays) => void;
  onRepositoryChange: (repository?: string) => void;
}) {
  const handlePeriodChange = (value: string) => {
    if (value === '7') onPeriodChange(7);
    if (value === '30') onPeriodChange(30);
    if (value === '90') onPeriodChange(90);
  };

  return (
    <section className="space-y-3" aria-labelledby="review-analytics-filters-heading">
      <div className="flex min-h-5 items-center justify-between gap-3">
        <h2 id="review-analytics-filters-heading" className="text-sm font-medium">
          Filters
        </h2>
        {updating && (
          <span
            className="text-muted-foreground flex items-center gap-2 text-xs"
            role="status"
            aria-live="polite"
          >
            <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
            Updating...
          </span>
        )}
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="review-analytics-period">Period</Label>
          <Select value={String(period)} onValueChange={handlePeriodChange}>
            <SelectTrigger id="review-analytics-period" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="7">Last 7 days</SelectItem>
              <SelectItem value="30">Last 30 days</SelectItem>
              <SelectItem value="90">Last 90 days</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-2">
          <Label htmlFor="review-analytics-repository">Repository</Label>
          <Select
            value={repository ?? ALL_REPOSITORIES}
            onValueChange={value =>
              onRepositoryChange(value === ALL_REPOSITORIES ? undefined : value)
            }
          >
            <SelectTrigger id="review-analytics-repository" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL_REPOSITORIES}>All repositories</SelectItem>
              {repositoryOptions.map(option => (
                <SelectItem key={option} value={option}>
                  {option}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
    </section>
  );
}

function CoverageStrip({
  coverage,
}: {
  coverage: {
    enrolledCompletedReviews: number;
    captured: number;
    missing: number;
    invalid: number;
    omitted: number;
    capturePercentage: number | null;
  };
}) {
  return (
    <section className="bg-muted/20 rounded-xl border p-4" aria-labelledby="analytics-coverage">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-1">
          <h2 id="analytics-coverage" className="text-sm font-medium">
            Structured results: {formatCount(coverage.captured)} of{' '}
            {formatCount(coverage.enrolledCompletedReviews)} enrolled completed reviews.
          </h2>
          <p className="text-muted-foreground text-xs">
            Missing, invalid, and omitted reviews are excluded from finding and impact metrics.
          </p>
        </div>
        {coverage.capturePercentage !== null && (
          <Badge variant="outline" className="tabular-nums">
            {coverage.capturePercentage.toLocaleString(undefined, {
              maximumFractionDigits: 1,
            })}
            % captured
          </Badge>
        )}
      </div>
      <dl className="text-muted-foreground mt-3 flex flex-wrap gap-x-5 gap-y-1 text-xs tabular-nums">
        <div className="flex gap-1.5">
          <dt>Missing</dt>
          <dd className="text-foreground">{formatCount(coverage.missing)}</dd>
        </div>
        <div className="flex gap-1.5">
          <dt>Invalid</dt>
          <dd className="text-foreground">{formatCount(coverage.invalid)}</dd>
        </div>
        <div className="flex gap-1.5">
          <dt>Omitted</dt>
          <dd className="text-foreground">{formatCount(coverage.omitted)}</dd>
        </div>
      </dl>
    </section>
  );
}

function EmptyAnalyticsState({ message }: { message: string }) {
  return (
    <div className="rounded-xl border border-dashed p-8 text-center">
      <ChartColumnIncreasing
        className="text-muted-foreground mx-auto mb-3 size-5"
        aria-hidden="true"
      />
      <p className="text-muted-foreground text-sm">{message}</p>
    </div>
  );
}

export function CodeReviewAnalyticsPanel({
  organizationId,
  platform,
}: CodeReviewAnalyticsPanelProps) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [period, setPeriod] = useState<PeriodDays>(30);
  const [repository, setRepository] = useState<string>();
  const [hasObservedHistory, setHasObservedHistory] = useState(false);

  const queryInput = useMemo(
    () => ({
      platform,
      periodDays: period,
      organizationId,
      ...(repository ? { repository } : {}),
    }),
    [organizationId, period, platform, repository]
  );

  const dashboardQuery = useQuery(
    trpc.codeReviews.analytics.getDashboard.queryOptions(queryInput, {
      placeholderData: keepPreviousData,
    })
  );
  const dashboard = dashboardQuery.data;

  useEffect(() => {
    if (
      dashboard &&
      (dashboard.coverage.enrolledCompletedReviews > 0 || dashboard.repositoryOptions.length > 0)
    ) {
      setHasObservedHistory(true);
    }
  }, [dashboard]);

  useEffect(() => {
    if (
      repository &&
      dashboard &&
      !dashboardQuery.isPlaceholderData &&
      !dashboard.repositoryOptions.includes(repository)
    ) {
      setRepository(undefined);
    }
  }, [dashboard, dashboardQuery.isPlaceholderData, repository]);

  const setEnabledMutation = useMutation(
    trpc.codeReviews.analytics.setEnabled.mutationOptions({
      onSuccess: result => {
        queryClient.setQueryData(
          trpc.codeReviews.analytics.getDashboard.queryKey(queryInput),
          previous =>
            previous
              ? {
                  ...previous,
                  settings: { ...previous.settings, enabled: result.enabled },
                }
              : previous
        );
        toast.success(
          result.enabled ? 'Analytics collection enabled' : 'Analytics collection paused'
        );
      },
      onError: error => {
        toast.error('Failed to update analytics collection', { description: error.message });
      },
    })
  );

  if (dashboardQuery.isPending && !dashboard) {
    return <AnalyticsLoadingState platform={platform} />;
  }

  if (!dashboard) {
    return (
      <Alert variant="destructive">
        <ShieldAlert aria-hidden="true" />
        <AlertTitle>Analytics could not load</AlertTitle>
        <AlertDescription className="gap-3">
          <p>{dashboardQuery.error?.message ?? 'Try again in a moment.'}</p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void dashboardQuery.refetch()}
            disabled={dashboardQuery.isFetching}
          >
            {dashboardQuery.isFetching ? (
              <Loader2 className="animate-spin" aria-hidden="true" />
            ) : (
              <RefreshCw aria-hidden="true" />
            )}
            Retry analytics
          </Button>
        </AlertDescription>
      </Alert>
    );
  }

  const hasCurrentHistory =
    dashboard.coverage.enrolledCompletedReviews > 0 || dashboard.repositoryOptions.length > 0;
  const hasHistory = hasObservedHistory || hasCurrentHistory;
  const collectionPausedWithHistory = !dashboard.settings.enabled && hasHistory;
  const noEnrolledReviews = dashboard.coverage.enrolledCompletedReviews === 0;
  const filteredSelection = repository !== undefined || period !== 30 || hasObservedHistory;
  const trackedLabel = platform === 'github' ? 'Tracked PRs' : 'Tracked MRs';

  return (
    <div className="space-y-6" aria-busy={dashboardQuery.isFetching}>
      <AnalyticsCollectionCard
        enabled={dashboard.settings.enabled}
        canManage={dashboard.settings.canManage}
        isPending={setEnabledMutation.isPending}
        onEnabledChange={enabled =>
          setEnabledMutation.mutate({
            platform,
            enabled,
            organizationId,
          })
        }
      />

      <AnalyticsFilters
        period={period}
        repository={repository}
        repositoryOptions={dashboard.repositoryOptions}
        updating={dashboardQuery.isFetching && !dashboardQuery.isPending}
        onPeriodChange={setPeriod}
        onRepositoryChange={setRepository}
      />

      {dashboardQuery.isError && (
        <Alert variant="destructive">
          <ShieldAlert aria-hidden="true" />
          <AlertTitle>Analytics could not refresh</AlertTitle>
          <AlertDescription className="gap-3">
            <p>{dashboardQuery.error.message}</p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void dashboardQuery.refetch()}
              disabled={dashboardQuery.isFetching}
            >
              <RefreshCw aria-hidden="true" />
              Retry analytics
            </Button>
          </AlertDescription>
        </Alert>
      )}

      {collectionPausedWithHistory && (
        <div className="bg-muted/20 flex items-start gap-3 rounded-xl border p-4">
          <PauseCircle
            className="text-muted-foreground mt-0.5 size-4 shrink-0"
            aria-hidden="true"
          />
          <div className="space-y-1">
            <p className="text-sm font-medium">Collection paused</p>
            <p className="text-muted-foreground text-sm">
              Collection is paused. Existing analytics remain available.
            </p>
          </div>
        </div>
      )}

      {dashboard.coverage.enrolledCompletedReviews > 0 && (
        <CoverageStrip coverage={dashboard.coverage} />
      )}

      {noEnrolledReviews ? (
        !dashboard.settings.enabled && !hasHistory ? (
          <EmptyAnalyticsState message="No analytics data yet. Turn on collection to track future completed reviews. Existing reviews are not backfilled." />
        ) : filteredSelection || collectionPausedWithHistory ? (
          <EmptyAnalyticsState message="No analytics data for this period and repository." />
        ) : (
          <EmptyAnalyticsState message="Waiting for a completed review." />
        )
      ) : dashboard.coverage.captured === 0 ? (
        <div className="rounded-xl border border-dashed p-6">
          <p className="text-sm font-medium">No structured results available</p>
          <p className="text-muted-foreground mt-1 text-sm">
            Enrolled reviews were completed, but their structured results were missing, invalid, or
            omitted. Finding and impact metrics are unavailable for this selection.
          </p>
        </div>
      ) : (
        <>
          <section className="grid grid-cols-2 gap-3 lg:grid-cols-4" aria-label="Analytics summary">
            <MetricCard
              title={trackedLabel}
              value={
                <span className="tabular-nums">
                  {formatCount(dashboard.summary.trackedPrsOrMrs)}
                </span>
              }
              icon={GitPullRequest}
            />
            <MetricCard
              title="Impact points"
              value={
                <span className="tabular-nums">
                  {formatCount(dashboard.summary.estimatedImpactPoints)}
                </span>
              }
              icon={CircleGauge}
              subtext="AI-estimated"
            />
            <MetricCard
              title="High impact"
              value={
                <span className="tabular-nums">
                  {formatCount(dashboard.summary.highImpactChanges)}
                </span>
              }
              icon={TrendingUp}
              subtext="AI-estimated changes"
            />
            <MetricCard
              title="Findings raised"
              value={
                <span className="tabular-nums">{formatCount(dashboard.summary.totalFindings)}</span>
              }
              icon={MessageSquareWarning}
              subtext={
                <span className="tabular-nums">
                  {formatCount(dashboard.summary.criticalFindings)} critical /{' '}
                  {formatCount(dashboard.summary.warningFindings)} warning
                </span>
              }
            />
          </section>

          <AnalyticsBreakdownBars
            impactBreakdown={dashboard.impactBreakdown}
            modelBreakdown={dashboard.modelBreakdown}
            findingBreakdown={dashboard.findingBreakdown}
            securityBreakdown={dashboard.securityBreakdown}
          />

          <AnalyticsTables
            platform={platform}
            repositories={dashboard.repositories}
            contributors={dashboard.contributors}
          />
        </>
      )}
    </div>
  );
}
